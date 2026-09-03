import {
  assertUsageAllowed,
  readUsageGuardEvidence,
  UsageGuardError,
} from "../../shared/usageGuard";
import {
  beginRun,
  dueAlerts,
  failRun,
  finishRun,
  initializeBaseline,
  isBaselineInitialized,
  markAlertRetry,
  markAlertSent,
  recordDeltaStatement,
  resolveProvenAlertStatement,
  sourceCursor,
  touchPollStatement,
  updateSourceCursorStatement,
} from "./db";
import { deliverAlert, DiscordObserverError } from "./discord";
import {
  deliveryObservation,
  failureObservation,
  observerIntegrityObservation,
  rejectionObservation,
  runtimeObservation,
} from "./policy";
import type {
  DeliveryAggregateRow,
  FailureAggregateRow,
  RejectionAggregateRow,
  SourceObservation,
  StatsObserverEnv,
} from "./types";

const OVERLAP_SECONDS = 35 * 60;

export async function runObserver(
  env: StatsObserverEnv,
  scheduledAtMs: number,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
) {
  const nowMs = options.now?.() ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const scheduledAt = new Date(scheduledAtMs).toISOString();
  const runId = `obs-${env.ENVIRONMENT}-${scheduledAt.replace(/[^0-9]/g, "")}-${normalizedSha(env.DEPLOY_SHA).slice(0, 12)}`;

  if (!(await beginRun(env, runId, scheduledAt, now))) return { duplicate: true };

  try {
    const guardAccess = await assertUsageAllowed(env.GUARD_DB, "statistics_read", nowMs);
    if (nowMs - Date.parse(guardAccess.observedAt) >= 45 * 60_000) {
      throw new UsageGuardError("hard_stop");
    }
    const guard = await readUsageGuardEvidence(env.GUARD_DB);
    const baseline = await isBaselineInitialized(env);
    const observations = await readObservations(
      env,
      baseline ? Math.floor(nowMs / 1_000) - OVERLAP_SECONDS : 0,
      guard,
    );
    const hashed = await Promise.all(
      observations.map(async (observation) => ({
        observation,
        canonicalIdentity: canonicalIdentity(observation.identity),
        rowHash: await hashIdentity(observation.identity),
        fingerprint: await hashIdentity({
          environment: env.ENVIRONMENT,
          ...observation.fingerprintIdentity,
        }),
      })),
    );

    if (!baseline) {
      await initializeBaseline(
        env,
        hashed.map(({ observation, rowHash }) => ({
          sourceKind: observation.sourceKind,
          rowHash,
          events: validCount(observation.events),
          lastSeen: validTimestamp(observation.lastSeen, nowMs),
        })),
        now,
      );
      await finishRun(env, runId, { rows: hashed.length, deltas: 0, alerts: 0 });
      return { baselineInitialized: true, rows: hashed.length };
    }

    const pending = new Map<
      string,
      { observation: SourceObservation; fingerprint: string; delta: number; contexts: string[] }
    >();
    const provenRecoveries = new Set<string>();
    const cursorStatements: D1PreparedStatement[] = [];
    const collisionKeys = identityCollisionKeys(hashed);
    const handledCollisions = new Set<string>();
    let deltas = 0;
    for (const item of hashed) {
      const { observation, rowHash, fingerprint } = item;
      const cursorKey = `${observation.sourceKind}:${rowHash}`;
      const lastSeen = validTimestamp(observation.lastSeen, nowMs);
      if (collisionKeys.has(cursorKey)) {
        if (!handledCollisions.has(cursorKey)) {
          await mergeIntegrity(
            pending,
            env.ENVIRONMENT,
            observerIntegrityObservation({
              errorCode: "observer_identity_collision",
              sourceKind: observation.sourceKind,
              rowHash,
              now: Math.floor(nowMs / 1_000),
            }),
          );
          handledCollisions.add(cursorKey);
          deltas += 1;
        }
        cursorStatements.push(
          updateSourceCursorStatement(env, observation.sourceKind, rowHash, 0, lastSeen, now),
        );
        continue;
      }
      const events = nonnegativeCount(observation.events);
      if (events === null) {
        await mergeIntegrity(
          pending,
          env.ENVIRONMENT,
          observerIntegrityObservation({
            errorCode: "observer_invalid_count",
            sourceKind: observation.sourceKind,
            rowHash,
            now: Math.floor(nowMs / 1_000),
          }),
        );
        cursorStatements.push(
          updateSourceCursorStatement(env, observation.sourceKind, rowHash, 0, lastSeen, now),
        );
        deltas += 1;
        continue;
      }
      const cursor = await sourceCursor(env, observation.sourceKind, rowHash);
      const previous = cursor ? validCount(cursor.last_events) : 0;
      const delta = events - previous;
      if (delta < 0 && observation.sourceKind !== "worker_runtime") {
        await mergeIntegrity(
          pending,
          env.ENVIRONMENT,
          observerIntegrityObservation({
            errorCode: "observer_count_decrease",
            sourceKind: observation.sourceKind,
            rowHash,
            now: Math.floor(nowMs / 1_000),
          }),
        );
        deltas += 1;
      } else if (
        observation.sourceKind === "worker_runtime" &&
        cursor &&
        previous > 0 &&
        events === 0
      ) {
        provenRecoveries.add(fingerprint);
      } else if (delta > 0 && observation.alertable) {
        // Aggregate rows retain their historical first_seen value. Once a baseline exists,
        // attribute a positive delta to the latest observation window instead of pre-baseline time.
        const deltaObservation = cursor
          ? { ...observation, firstSeen: lastSeen }
          : observation;
        mergeDelta(pending, fingerprint, deltaObservation, delta);
        deltas += delta;
      }
      cursorStatements.push(
        updateSourceCursorStatement(
          env,
          observation.sourceKind,
          rowHash,
          events,
          lastSeen,
          now,
        ),
      );
    }

    const deltaStatements: D1PreparedStatement[] = [];
    for (const item of pending.values()) {
      const commonContext = Object.fromEntries(
        Object.entries(item.observation.context).filter(
          ([key]) => !["stateBucket", "stockBuckets", "client"].includes(key),
        ),
      );
      item.observation.context = {
        ...commonContext,
        ...Object.fromEntries(
          item.contexts.slice(0, 3).map((context, index) => [`occurrence${index + 1}`, context]),
        ),
      };
      deltaStatements.push(
        await recordDeltaStatement(env, item.observation, item.fingerprint, item.delta, now),
      );
    }
    const recoveryStatements = [...provenRecoveries].map((fingerprint) =>
      resolveProvenAlertStatement(env, fingerprint, now),
    );
    await env.OBSERVER_DB.batch([
      ...deltaStatements,
      ...recoveryStatements,
      ...cursorStatements,
      touchPollStatement(env, now),
    ]);

    const alerts = await flushAlerts(env, now, options.fetchImpl);
    await finishRun(env, runId, { rows: hashed.length, deltas, alerts });
    return { rows: hashed.length, deltas, alerts };
  } catch (error) {
    await failRun(env, runId, errorCode(error)).catch(() => undefined);
    throw error;
  }
}

export function identityCollisionKeys(
  rows: Array<{
    observation: SourceObservation;
    canonicalIdentity: string;
    rowHash: string;
  }>,
) {
  const canonicalByKey = new Map<string, string>();
  const collisions = new Set<string>();
  for (const row of rows) {
    const key = `${row.observation.sourceKind}:${row.rowHash}`;
    const existing = canonicalByKey.get(key);
    if (existing !== undefined && existing !== row.canonicalIdentity) collisions.add(key);
    else canonicalByKey.set(key, row.canonicalIdentity);
  }
  return collisions;
}

async function mergeIntegrity(
  pending: Map<
    string,
    { observation: SourceObservation; fingerprint: string; delta: number; contexts: string[] }
  >,
  environment: string,
  observation: SourceObservation,
) {
  const fingerprint = await hashIdentity({ environment, ...observation.fingerprintIdentity });
  mergeDelta(pending, fingerprint, observation, 1);
}

async function readObservations(
  env: StatsObserverEnv,
  cutoff: number,
  guard: Awaited<ReturnType<typeof readUsageGuardEvidence>>,
) {
  const predicate = "WHERE last_seen >= ?";
  const bind = <T>(query: string) => {
    return env.STATS_DB.prepare(query).bind(cutoff).all<T>();
  };
  const [failures, rejections, delivery] = await Promise.all([
    bind<FailureAggregateRow>(
      `SELECT * FROM solver_failure_aggregates_game_day ${predicate} ORDER BY last_seen ASC LIMIT 501`,
    ),
    bind<RejectionAggregateRow>(
      `SELECT * FROM stats_submission_rejection_aggregates_game_day ${predicate} ORDER BY last_seen ASC LIMIT 501`,
    ),
    bind<DeliveryAggregateRow>(
      `SELECT * FROM stats_delivery_health_aggregates_game_day ${predicate} ORDER BY last_seen ASC LIMIT 501`,
    ),
  ]);
  const failureRows = boundedRows(failures.results);
  const rejectionRows = boundedRows(rejections.results);
  const deliveryRows = boundedRows(delivery.results);
  const observations: SourceObservation[] = [
    ...failureRows.map(failureObservation),
    ...rejectionRows.map(rejectionObservation),
    ...deliveryRows.map(deliveryObservation),
  ];

  const scriptName = env.ENVIRONMENT === "production" ? "collection-kit-stats" : "collection-kit-stats-staging";
  const runtime = guard.evidence.workerRuntime.workers.find((worker) => worker.scriptName === scriptName);
  if (runtime) {
    const firstSeen = Math.floor(Date.parse(guard.evidence.workerRuntime.startedAt) / 1_000);
    const lastSeen = Math.floor(Date.parse(guard.evidence.workerRuntime.endedAt) / 1_000);
    const deploymentWindow = `${guard.evidence.workerRuntime.startedAt}/${guard.evidence.workerRuntime.endedAt}`;
    observations.push(
      runtimeObservation({
        environment: env.ENVIRONMENT,
        deploymentWindow,
        errorCode: "worker_runtime_error",
        events: runtime.errorsObserved,
        firstSeen,
        lastSeen,
      }),
      runtimeObservation({
        environment: env.ENVIRONMENT,
        deploymentWindow,
        errorCode: "worker_exceeded_cpu",
        events: runtime.exceededCpuObserved,
        firstSeen,
        lastSeen,
      }),
    );
  }
  return observations;
}

function boundedRows<T>(rows: T[] | undefined) {
  if ((rows?.length ?? 0) > 500) throw new Error("observer_source_overflow");
  return rows ?? [];
}

function mergeDelta(
  pending: Map<
    string,
    { observation: SourceObservation; fingerprint: string; delta: number; contexts: string[] }
  >,
  fingerprint: string,
  observation: SourceObservation,
  delta: number,
) {
  const context = [
    observation.context["stateBucket"] ? `state=${observation.context["stateBucket"]}` : "",
    observation.context["stockBuckets"] ? `stock=${observation.context["stockBuckets"]}` : "",
    observation.context["client"] ? `client=${observation.context["client"]}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const current = pending.get(fingerprint);
  if (!current) {
    pending.set(fingerprint, {
      observation: { ...observation },
      fingerprint,
      delta,
      contexts: [context],
    });
    return;
  }
  current.delta += delta;
  current.observation.immediateCritical ||= observation.immediateCritical;
  current.observation.firstSeen = Math.min(current.observation.firstSeen, observation.firstSeen);
  current.observation.lastSeen = Math.max(current.observation.lastSeen, observation.lastSeen);
  if (!current.contexts.includes(context)) current.contexts.push(context);
}

async function flushAlerts(env: StatsObserverEnv, now: string, fetchImpl?: typeof fetch) {
  const alerts = await dueAlerts(env, now);
  for (const alert of alerts) {
    try {
      const messageId = await deliverAlert(env, alert, fetchImpl, Date.parse(now));
      await markAlertSent(env, alert, messageId, now);
    } catch (error) {
      const retryAfterMs = error instanceof DiscordObserverError ? error.retryAfterMs : null;
      const retryable = error instanceof DiscordObserverError && error.retryable;
      const nextSendAt = retryable
        ? new Date(Date.parse(now) + (retryAfterMs ?? 5 * 60_000)).toISOString()
        : null;
      await markAlertRetry(env, alert.fingerprint, errorCode(error), nextSendAt);
    }
  }
  return alerts.length;
}

async function hashIdentity(identity: Record<string, string | number>) {
  const canonical = canonicalIdentity(identity);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalIdentity(identity: Record<string, string | number>) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(identity).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function nonnegativeCount(value: unknown) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function validCount(value: unknown) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("observer_invalid_count");
  return count;
}

function validTimestamp(value: unknown, fallbackMs: number) {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : Math.floor(fallbackMs / 1_000);
}

function normalizedSha(value: string) {
  return /^[0-9a-f]{40}$/.test(value) || value === "local" ? value : "unknown";
}

function errorCode(error: unknown) {
  if (error instanceof DiscordObserverError) return error.code;
  if (error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message)) return error.message;
  return "observer_internal_error";
}
