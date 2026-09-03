import { assertD1QuotaEvidence } from "../../shared/d1QuotaEvidence";
import {
  assertForecastCandidateInvariants,
  supplyForecastCandidateSchema,
} from "../../shared/supplyForecastCandidate";
import type { UsageGuardEvidence, UsageGuardState } from "../../shared/usageGuard";
import { assertCanaryStartWindow, CANARY_WINDOW_MS, readQuotaEvidence } from "./canary-quota";
import { sha256Hex, stableJson } from "./crypto";

const WINDOW_MODE = "fixed_8_hours" as const;
const MINIMUM_DELIVERY_RATE = 0.99;
const MINIMUM_COMPLETION_RATE = 0.99;
const COLLECTOR_CRON = "*/3 * * * *";
const DISPATCHER_CRON = "1-59/3 * * * *";
const ABANDONED_AFTER_MS = 15 * 60 * 1_000;

type Environment = "staging" | "production";
type CanaryRunRow = {
  canary_id: string;
  environment: Environment;
  deployment_sha: string;
  collector_cron: string;
  dispatcher_cron: string;
  started_at: string;
  ends_at: string;
  quota_evidence_json: string;
  quota_evidence_hash: string;
};

type InvocationRow = {
  status: string;
  scheduled_at: string;
  started_at: string;
  poll_mode?: "both" | "alternating";
  error_code?: string | null;
};

export async function startCanaryDeployment(
  db: D1Database,
  input: {
    environment: Environment;
    canaryId: string;
    deploymentSha: string;
    collectorCron: string;
    dispatcherCron: string;
    quotaEvidence: unknown;
    nowMs?: number;
  },
) {
  if (!/^fc-[0-9a-f]{32}$/.test(input.canaryId)) throw new Error("canary_id_invalid");
  if (!/^[0-9a-f]{40}$/.test(input.deploymentSha)) throw new Error("canary_deployment_sha_invalid");
  if (input.collectorCron !== COLLECTOR_CRON || input.dispatcherCron !== DISPATCHER_CRON) {
    throw new Error("canary_cron_contract_invalid");
  }
  const quotaEvidence = assertD1QuotaEvidence(input.quotaEvidence);
  const quotaEvidenceJson = stableJson(quotaEvidence);
  const quotaEvidenceHash = await sha256Hex(quotaEvidenceJson);
  const existing = await readRunById(db, input.canaryId);
  if (existing) {
    if (
      existing.environment !== input.environment ||
      existing.deployment_sha !== input.deploymentSha ||
      existing.collector_cron !== input.collectorCron ||
      existing.dispatcher_cron !== input.dispatcherCron ||
      existing.quota_evidence_hash !== quotaEvidenceHash
    ) {
      throw new Error("canary_run_conflict");
    }
    return publicRun(existing);
  }
  const nowMs = input.nowMs ?? Date.now();
  assertCanaryStartWindow(nowMs, quotaEvidence);
  const startedAt = new Date(nowMs).toISOString();
  const endsAt = new Date(nowMs + CANARY_WINDOW_MS).toISOString();
  const overlapping = await db
    .prepare(
      `SELECT canary_id FROM canary_runs
       WHERE environment = ? AND deployment_sha = ? AND ends_at > ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .bind(input.environment, input.deploymentSha, startedAt)
    .first<{ canary_id: string }>();
  if (overlapping) throw new Error("canary_run_overlap");
  await db
    .prepare(
      `INSERT INTO canary_runs (
         canary_id, environment, deployment_sha, collector_cron, dispatcher_cron,
         started_at, ends_at, quota_evidence_json, quota_evidence_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.canaryId,
      input.environment,
      input.deploymentSha,
      input.collectorCron,
      input.dispatcherCron,
      startedAt,
      endsAt,
      quotaEvidenceJson,
      quotaEvidenceHash,
      startedAt,
    )
    .run();
  const stored = await readRunById(db, input.canaryId);
  if (!stored) throw new Error("canary_run_missing_after_insert");
  return publicRun(stored);
}

export async function readCanaryReport(
  db: D1Database,
  nowMs: number,
  deploymentSha: string,
  environment: Environment = "staging",
  canaryId?: string,
  runtimeQuota?: UsageGuardEvidence | UsageGuardState,
) {
  const run = canaryId
    ? await readRunById(db, canaryId)
    : await readLatestRun(db, environment, deploymentSha);
  if (!run || run.environment !== environment || run.deployment_sha !== deploymentSha) {
    return missingReport(deploymentSha, environment, nowMs, canaryId ?? null);
  }
  const startedMs = Date.parse(run.started_at);
  const endsMs = Date.parse(run.ends_at);
  const eligible = nowMs >= endsMs;
  const quota = await readQuotaEvidence(run, runtimeQuota, nowMs, environment, {
    finalEvidenceRequired: eligible,
    runtimeStartedAt: run.started_at,
    runtimeEndedAt: run.ends_at,
  });
  const observationEndMs = Math.min(nowMs, endsMs);
  const collectorExpected = expectedSlots(startedMs, observationEndMs, 0);
  const dispatcherExpected = expectedSlots(startedMs, observationEndMs, 1);
  const invocations = await readInvocations(
    db,
    "collector_invocations",
    deploymentSha,
    run.started_at,
    new Date(observationEndMs).toISOString(),
  );
  const dispatcherInvocations = await readInvocations(
    db,
    "dispatcher_invocations",
    deploymentSha,
    run.started_at,
    new Date(observationEndMs).toISOString(),
  );
  const collector = summarizeInvocations(invocations, collectorExpected, nowMs, observationEndMs);
  const dispatcherInvocationSummary = summarizeInvocations(
    dispatcherInvocations,
    dispatcherExpected,
    nowMs,
    observationEndMs,
  );

  const [dispatches, invariants, interactions] = await Promise.all([
    dispatchSummary(db, deploymentSha, run.started_at, run.ends_at),
    invariantSummary(db, environment, run.started_at, run.ends_at),
    interactionSummary(db, environment, run.started_at, run.ends_at),
  ]);
  const afterTwoHours = observationEndMs - startedMs >= 2 * 60 * 60 * 1_000;
  const earlyFailureReasons = collectEarlyFailureReasons(
    collector,
    dispatcherInvocationSummary,
    invariants,
    interactions,
    afterTwoHours,
  );
  const collectorPassed = invocationPassed(collector, eligible);
  const dispatcherPassed = dispatchPassed(dispatcherInvocationSummary, dispatches, eligible);
  const routerPassed = interactionPassed(interactions);
  const passed = reportPassed({
    eligible,
    collectorPassed,
    dispatcherPassed,
    routerPassed,
    quotaPassed: quota.valid,
    totalInvalid: invariants.totalInvalid,
    earlyFailureCount: earlyFailureReasons.length,
  });

  return {
    version: 8,
    canaryId: run.canary_id,
    deploymentSha,
    environment,
    pollMode: invocations.at(-1)?.poll_mode ?? "missing",
    acceptance: {
      windowMode: WINDOW_MODE,
      windowHours: CANARY_WINDOW_MS / (60 * 60 * 1_000),
      minimumDeliveryRate: MINIMUM_DELIVERY_RATE,
      minimumCompletionRate: MINIMUM_COMPLETION_RATE,
      maximumMissingSlots: 1,
    },
    window: {
      startedAt: run.started_at,
      endsAt: run.ends_at,
      observedUntil: new Date(observationEndMs).toISOString(),
      eligible,
      earlyFailure: earlyFailureReasons.length > 0,
      earlyFailureReasons,
    },
    collector,
    dispatcher: { ...dispatcherInvocationSummary, ...dispatches, passed: dispatcherPassed },
    router: { ...interactions, passed: routerPassed },
    quota,
    invariants,
    passed,
  };
}

export async function readCanaryWindow(
  db: D1Database,
  nowMs: number,
  deploymentSha: string,
  environment: Environment = "staging",
  canaryId?: string,
) {
  const run = canaryId
    ? await readRunById(db, canaryId)
    : await readLatestRun(db, environment, deploymentSha);
  if (!run || run.environment !== environment || run.deployment_sha !== deploymentSha) {
    return {
      version: 8,
      canaryId: canaryId ?? null,
      deploymentSha,
      environment,
      acceptance: { windowMode: WINDOW_MODE, windowHours: null },
      window: {
        startedAt: null,
        endsAt: null,
        observedAt: new Date(nowMs).toISOString(),
        active: false,
        eligible: false,
      },
    };
  }
  const startedMs = Date.parse(run.started_at);
  const endsMs = Date.parse(run.ends_at);
  return {
    version: 8,
    canaryId: run.canary_id,
    deploymentSha,
    environment,
    acceptance: {
      windowMode: WINDOW_MODE,
      windowHours: CANARY_WINDOW_MS / (60 * 60 * 1_000),
    },
    window: {
      startedAt: run.started_at,
      endsAt: run.ends_at,
      observedAt: new Date(nowMs).toISOString(),
      active: startedMs <= nowMs && nowMs < endsMs,
      eligible: nowMs >= endsMs,
    },
  };
}

async function readRunById(db: D1Database, canaryId: string) {
  return db
    .prepare(
      `SELECT canary_id, environment, deployment_sha, collector_cron, dispatcher_cron,
              started_at, ends_at, quota_evidence_json, quota_evidence_hash
       FROM canary_runs WHERE canary_id = ?`,
    )
    .bind(canaryId)
    .first<CanaryRunRow>();
}

async function readLatestRun(db: D1Database, environment: Environment, deploymentSha: string) {
  return db
    .prepare(
      `SELECT canary_id, environment, deployment_sha, collector_cron, dispatcher_cron,
              started_at, ends_at, quota_evidence_json, quota_evidence_hash
       FROM canary_runs WHERE environment = ? AND deployment_sha = ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .bind(environment, deploymentSha)
    .first<CanaryRunRow>();
}

async function readInvocations(
  db: D1Database,
  table: "collector_invocations" | "dispatcher_invocations",
  deploymentSha: string,
  startedAt: string,
  endsAt: string,
) {
  const extra = table === "collector_invocations" ? ", poll_mode, error_code" : "";
  const rows = await db
    .prepare(
      `SELECT status, scheduled_at, started_at${extra} FROM ${table}
       WHERE deployment_sha = ? AND scheduled_at >= ? AND scheduled_at < ?
       ORDER BY scheduled_at`,
    )
    .bind(deploymentSha, startedAt, endsAt)
    .all<InvocationRow>();
  return rows.results;
}

function summarizeInvocations(
  rows: InvocationRow[],
  expected: string[],
  nowMs: number,
  observationEndMs: number,
) {
  const expectedSet = new Set(expected);
  const slotCounts = new Map<string, number>();
  let completed = 0;
  let failure = 0;
  let abandoned = 0;
  let partialSchemaRejections = 0;
  let unexpectedInvocations = 0;
  let lateInvocations = 0;
  for (const row of rows) {
    const slot = normalizeSlot(row.scheduled_at);
    if (expectedSet.has(slot)) {
      slotCounts.set(slot, (slotCounts.get(slot) ?? 0) + 1);
    } else {
      unexpectedInvocations += 1;
    }
    const status =
      row.status === "running" && nowMs - Date.parse(row.scheduled_at) >= ABANDONED_AFTER_MS
        ? "abandoned"
        : row.status;
    if (status === "completed") completed += 1;
    if (status === "failure") failure += 1;
    if (status === "abandoned") abandoned += 1;
    if (row.error_code === "naver_partial_schema_drift") partialSchemaRejections += 1;
    if (Date.parse(row.started_at) >= observationEndMs) lateInvocations += 1;
  }
  const observedSlots = slotCounts.size;
  const missingSlots = expected.filter((slot) => !slotCounts.has(slot)).length;
  const duplicateInvocations = [...slotCounts.values()].filter((count) => count > 1).length;
  const deliveryRate = ratio(observedSlots, expected.length);
  const completionRate = ratio(completed, rows.length);
  const abandonedRate = ratio(abandoned, rows.length);
  const missingRate = ratio(missingSlots, expected.length);
  return {
    expectedSlots: expected.length,
    observedSlots,
    missingSlots,
    deliveryRate,
    completed,
    failure,
    abandoned,
    completionRate,
    abandonedRate,
    missingRate,
    duplicateInvocations,
    unexpectedInvocations,
    lateInvocations,
    partialSchemaRejections,
    latestStatus: rows.at(-1)?.status ?? "missing",
  };
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function invocationPassed(summary: ReturnType<typeof summarizeInvocations>, eligible: boolean) {
  return (
    eligible &&
    summary.deliveryRate >= MINIMUM_DELIVERY_RATE &&
    summary.completionRate >= MINIMUM_COMPLETION_RATE &&
    summary.missingSlots <= 1 &&
    summary.latestStatus === "completed" &&
    summary.abandoned === 0 &&
    summary.duplicateInvocations === 0 &&
    summary.unexpectedInvocations === 0 &&
    summary.lateInvocations === 0 &&
    summary.partialSchemaRejections === 0
  );
}

function collectEarlyFailureReasons(
  collector: ReturnType<typeof summarizeInvocations>,
  dispatcher: ReturnType<typeof summarizeInvocations>,
  invariants: Awaited<ReturnType<typeof invariantSummary>>,
  interactions: Awaited<ReturnType<typeof interactionSummary>>,
  afterTwoHours: boolean,
) {
  if (!afterTwoHours) return [];
  return [
    collector.abandonedRate > 0.01 ? "collector_abandoned_over_1_percent" : null,
    dispatcher.abandonedRate > 0.01 ? "dispatcher_abandoned_over_1_percent" : null,
    collector.missingRate > 0.05 ? "collector_missing_slots_over_5_percent" : null,
    dispatcher.missingRate > 0.05 ? "dispatcher_missing_slots_over_5_percent" : null,
    invariants.totalInvalid > 0 ? "invariant_error" : null,
    interactions.failedAuthorizationSmoke > 0 ? "router_smoke_failed" : null,
  ].filter((value): value is string => value !== null);
}

function dispatchPassed(
  invocations: ReturnType<typeof summarizeInvocations>,
  dispatches: Awaited<ReturnType<typeof dispatchSummary>>,
  eligible: boolean,
) {
  return (
    invocationPassed(invocations, eligible) &&
    dispatches.duplicateDispatches === 0 &&
    dispatches.duplicateRuns === 0 &&
    dispatches.invalidStates === 0 &&
    dispatches.smokeCount >= 1 &&
    dispatches.invalidSmoke === 0
  );
}

function interactionPassed(interactions: Awaited<ReturnType<typeof interactionSummary>>) {
  return (
    interactions.routerTestCount >= 1 &&
    interactions.duplicateInteractions === 0 &&
    interactions.maxInitialResponseMs < 1_000
  );
}

function reportPassed(input: {
  eligible: boolean;
  collectorPassed: boolean;
  dispatcherPassed: boolean;
  routerPassed: boolean;
  quotaPassed: boolean;
  totalInvalid: number;
  earlyFailureCount: number;
}) {
  return (
    input.eligible &&
    input.collectorPassed &&
    input.dispatcherPassed &&
    input.routerPassed &&
    input.quotaPassed &&
    input.totalInvalid === 0 &&
    input.earlyFailureCount === 0
  );
}

async function dispatchSummary(db: D1Database, sha: string, startedAt: string, endsAt: string) {
  const rows = await db
    .prepare(
      `SELECT dispatch_id, slot_key, dispatch_mode, state, reserved_by_invocation,
              lease_until, requested_at, accepted_at, started_at, finished_at,
              github_http_status, github_run_id, github_run_attempt, github_run_url,
              error_code, discord_sent_at
       FROM workflow_dispatches
       WHERE dispatcher_deployment_sha = ? AND created_at >= ? AND created_at < ?
       ORDER BY created_at`,
    )
    .bind(sha, startedAt, endsAt)
    .all<DispatchStateRow & { dispatch_id: string; slot_key: string; dispatch_mode: string }>();
  const slots = new Map<string, number>();
  const runs = new Map<number, number>();
  let invalidStates = 0;
  let smokeCount = 0;
  let invalidSmoke = 0;
  for (const row of rows.results) {
    slots.set(row.slot_key, (slots.get(row.slot_key) ?? 0) + 1);
    if (row.github_run_id !== null)
      runs.set(row.github_run_id, (runs.get(row.github_run_id) ?? 0) + 1);
    if (!validDispatchState(row)) invalidStates += 1;
    if (row.dispatch_mode === "smoke") {
      smokeCount += 1;
      if (row.state !== "succeeded" || !hasRunIdentity(row) || row.discord_sent_at === null) {
        invalidSmoke += 1;
      }
    }
  }
  return {
    duplicateDispatches: [...slots.values()].filter((count) => count > 1).length,
    duplicateRuns: [...runs.values()].filter((count) => count > 1).length,
    invalidStates,
    smokeCount,
    invalidSmoke,
  };
}

async function loadInvariantRows(
  db: D1Database,
  environment: Environment,
  startedAt: string,
  endsAt: string,
) {
  const results = await Promise.all([
    db
      .prepare("SELECT status, attempts, source, item_id, url, published_at FROM source_queue")
      .all<{
        status: string;
        attempts: number;
        source: string;
        item_id: string;
        url: string;
        published_at: string;
      }>(),
    db
      .prepare(
        `SELECT source, committed_item_id, committed_published_at, scan_head_item_id,
                scan_head_published_at, next_offset FROM source_poll_state`,
      )
      .all<{
        source: string;
        committed_item_id: string | null;
        committed_published_at: string | null;
        scan_head_item_id: string | null;
        scan_head_published_at: string | null;
        next_offset: number;
      }>(),
    db
      .prepare(
        `SELECT payload_json, payload_hash FROM forecast_candidates
         WHERE state NOT IN ('approved', 'rejected', 'superseded')`,
      )
      .all<{ payload_json: string; payload_hash: string }>(),
    db
      .prepare(
        `SELECT w.source, w.item_id, w.published_at, w.content_hash,
                i.item_id AS stored_item_id, i.published_at AS stored_published_at,
                i.content_hash AS stored_content_hash
         FROM source_watermarks w LEFT JOIN source_items i
           ON i.source = w.source AND i.item_id = w.item_id`,
      )
      .all<{
        source: string;
        item_id: string;
        published_at: string;
        content_hash: string;
        stored_item_id: string | null;
        stored_published_at: string | null;
        stored_content_hash: string | null;
      }>(),
    db
      .prepare(
        `SELECT r.state, r.decision, r.request_id, r.request_payload_hash, r.resolved_at,
                r.generation, q.status AS queue_status, q.review_generation
         FROM source_manual_reviews r JOIN source_queue q
           ON q.source = r.source AND q.item_id = r.item_id`,
      )
      .all<{
        state: string;
        decision: string | null;
        request_id: string | null;
        request_payload_hash: string | null;
        resolved_at: string | null;
        generation: number;
        queue_status: string;
        review_generation: number;
      }>(),
    db
      .prepare(
        `SELECT q.source, q.item_id
         FROM source_queue q
         LEFT JOIN source_manual_reviews r
           ON r.source = q.source AND r.item_id = q.item_id
          AND r.generation = q.review_generation AND r.state = 'pending'
         LEFT JOIN forecast_ops_alerts a
           ON a.alert_key = 'manual-review:' || ? || ':' || q.source || ':' || q.item_id
          AND a.last_sent_at IS NOT NULL
         WHERE q.status = 'manual_review' AND (r.review_id IS NULL OR a.alert_key IS NULL)`,
      )
      .bind(environment)
      .all(),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM forecast_ops_alerts
         WHERE component = 'workflow-callback' AND last_seen_at >= ? AND last_seen_at < ?
           AND (error_code LIKE '%conflict%' OR error_code LIKE '%regression%')`,
      )
      .bind(startedAt, endsAt)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM forecast_ops_alerts
         WHERE environment = ? AND severity = 'critical' AND state = 'open'
           AND occurrence_count >= notify_after_count
           AND (last_sent_at IS NULL OR occurrence_count > last_sent_occurrence_count)`,
      )
      .bind(environment)
      .first<{ count: number }>(),
  ]);
  return results;
}

async function invariantSummary(
  db: D1Database,
  environment: Environment,
  startedAt: string,
  endsAt: string,
) {
  const [
    queue,
    cursors,
    candidates,
    watermarks,
    reviewRows,
    manualCoverage,
    callbackConflicts,
    unsent,
  ] = await loadInvariantRows(db, environment, startedAt, endsAt);

  let invalidCandidates = 0;
  for (const row of candidates.results) {
    try {
      const candidate = supplyForecastCandidateSchema.parse(JSON.parse(row.payload_json));
      assertForecastCandidateInvariants(candidate);
      if ((await sha256Hex(stableJson(candidate))) !== row.payload_hash) invalidCandidates += 1;
    } catch {
      invalidCandidates += 1;
    }
  }
  const invalidQueue = queue.results.filter((row) => {
    const url = URL.parse(row.url);
    return (
      !["pending", "processed", "ignored", "manual_review"].includes(row.status) ||
      row.attempts < 0 ||
      !/^naver-board-(48|56)$/.test(row.source) ||
      !/^\d{1,20}$/.test(row.item_id) ||
      !url ||
      url.protocol !== "https:" ||
      url.hostname !== "game.naver.com" ||
      !Number.isFinite(Date.parse(row.published_at))
    );
  }).length;
  const invalidCursors = cursors.results.filter(
    (row) =>
      !/^naver-board-(48|56)$/.test(row.source) ||
      row.next_offset < 0 ||
      (row.next_offset > 0 && (!row.scan_head_item_id || !row.scan_head_published_at)) ||
      (row.next_offset === 0 &&
        (row.scan_head_item_id !== null || row.scan_head_published_at !== null)) ||
      (row.committed_item_id === null) !== (row.committed_published_at === null),
  ).length;
  const invalidWatermarks = watermarks.results.filter(
    (row) =>
      row.stored_item_id !== row.item_id ||
      row.stored_published_at !== row.published_at ||
      row.stored_content_hash !== row.content_hash,
  ).length;
  const invalidReviews = reviewRows.results.filter(
    (row) =>
      (row.state === "pending" &&
        (row.queue_status !== "manual_review" || row.generation !== row.review_generation)) ||
      (row.state === "resolved" &&
        (!row.decision || !row.request_id || !row.request_payload_hash || !row.resolved_at)),
  ).length;
  const callbackStateConflicts = Number(callbackConflicts?.count ?? 0);
  const unsentCriticalAlerts = Number(unsent?.count ?? 0);
  const values = {
    queue: invalidQueue,
    cursors: invalidCursors,
    candidates: invalidCandidates,
    watermarks: invalidWatermarks,
    reviews: invalidReviews,
    manualReviewCoverage: manualCoverage.results.length,
    callbackStateConflicts,
    unsentCriticalAlerts,
  };
  return { ...values, totalInvalid: Object.values(values).reduce((sum, value) => sum + value, 0) };
}

async function interactionSummary(
  db: D1Database,
  environment: Environment,
  startedAt: string,
  endsAt: string,
) {
  const rows = await db
    .prepare(
      `SELECT action, result, initial_response_ms, replay_count, error_code
       FROM discord_interaction_audit
       WHERE environment = ? AND received_at >= ? AND received_at < ?`,
    )
    .bind(environment, startedAt, endsAt)
    .all<{
      action: string;
      result: string | null;
      initial_response_ms: number | null;
      replay_count: number;
      error_code: string | null;
    }>();
  const routerTests = rows.results.filter((row) => row.action === "router_test");
  return {
    routerTestCount: routerTests.filter((row) => row.result === "completed").length,
    duplicateInteractions: rows.results.reduce((sum, row) => sum + Number(row.replay_count), 0),
    maxInitialResponseMs: Math.max(
      0,
      ...rows.results.map((row) => Number(row.initial_response_ms ?? 0)),
    ),
    failedAuthorizationSmoke: routerTests.filter((row) => row.result === "failed").length,
  };
}

function expectedSlots(startedMs: number, endsMs: number, minuteRemainder: 0 | 1) {
  const result: string[] = [];
  let cursor = (Math.floor(startedMs / 60_000) + 1) * 60_000;
  while (cursor < endsMs) {
    if (new Date(cursor).getUTCMinutes() % 3 === minuteRemainder) {
      result.push(new Date(cursor).toISOString());
    }
    cursor += 60_000;
  }
  return result;
}

function normalizeSlot(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(Math.floor(timestamp / 60_000) * 60_000).toISOString()
    : "invalid";
}

function publicRun(row: CanaryRunRow) {
  return {
    canaryId: row.canary_id,
    environment: row.environment,
    deploymentSha: row.deployment_sha,
    collectorCron: row.collector_cron,
    dispatcherCron: row.dispatcher_cron,
    startedAt: row.started_at,
    endsAt: row.ends_at,
  };
}

function missingReport(
  deploymentSha: string,
  environment: Environment,
  nowMs: number,
  canaryId: string | null,
) {
  return {
    version: 8,
    canaryId,
    deploymentSha,
    environment,
    pollMode: "missing",
    acceptance: {
      windowMode: WINDOW_MODE,
      windowHours: null,
      minimumDeliveryRate: MINIMUM_DELIVERY_RATE,
      minimumCompletionRate: MINIMUM_COMPLETION_RATE,
      maximumMissingSlots: 1,
    },
    window: {
      startedAt: null,
      endsAt: null,
      observedUntil: new Date(nowMs).toISOString(),
      eligible: false,
      earlyFailure: false,
      earlyFailureReasons: ["canary_deployment_missing"],
    },
    collector: emptyInvocationSummary(),
    dispatcher: {
      ...emptyInvocationSummary(),
      duplicateDispatches: 0,
      duplicateRuns: 0,
      invalidStates: 0,
      smokeCount: 0,
      invalidSmoke: 0,
      passed: false,
    },
    router: {
      routerTestCount: 0,
      duplicateInteractions: 0,
      maxInitialResponseMs: 0,
      failedAuthorizationSmoke: 0,
      passed: false,
    },
    quota: {
      valid: false,
      errorCode: "canary_run_missing",
      evidence: null,
      evidenceHash: null,
      initialEvidenceHash: null,
      freshnessMinutes: null,
      cpu: null,
    },
    invariants: {
      queue: 0,
      cursors: 0,
      candidates: 0,
      watermarks: 0,
      reviews: 0,
      manualReviewCoverage: 0,
      callbackStateConflicts: 0,
      unsentCriticalAlerts: 0,
      totalInvalid: 0,
    },
    passed: false,
  };
}

function emptyInvocationSummary() {
  return {
    expectedSlots: 0,
    observedSlots: 0,
    missingSlots: 0,
    deliveryRate: 0,
    completed: 0,
    failure: 0,
    abandoned: 0,
    completionRate: 0,
    abandonedRate: 0,
    missingRate: 0,
    duplicateInvocations: 0,
    unexpectedInvocations: 0,
    lateInvocations: 0,
    partialSchemaRejections: 0,
    latestStatus: "missing",
  };
}

type DispatchStateRow = {
  state: string;
  reserved_by_invocation: string | null;
  lease_until: string | null;
  requested_at: string | null;
  accepted_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  github_http_status: number | null;
  github_run_id: number | null;
  github_run_attempt: number | null;
  github_run_url: string | null;
  error_code: string | null;
  discord_sent_at: string | null;
};

const dispatchStateValidators: Record<string, (row: DispatchStateRow) => boolean> = {
  pending: (row) => row.requested_at === null && row.accepted_at === null,
  reserved: (row) => row.reserved_by_invocation !== null && row.lease_until !== null,
  accepted: (row) =>
    row.requested_at !== null &&
    row.accepted_at !== null &&
    (row.github_http_status === 204 || (row.github_http_status === 200 && hasRunIdentity(row))),
  running: (row) => row.requested_at !== null && row.started_at !== null && hasRunIdentity(row),
  succeeded: (row) => row.finished_at !== null && hasRunIdentity(row),
  cancelled: (row) => row.finished_at !== null && hasRunIdentity(row),
  failed: (row) => row.finished_at !== null && (hasRunIdentity(row) || row.error_code !== null),
  stale: (row) => row.finished_at !== null && row.error_code !== null,
};

function validDispatchState(row: DispatchStateRow) {
  return dispatchStateValidators[row.state]?.(row) ?? false;
}

function hasRunIdentity(row: DispatchStateRow) {
  return (
    row.github_run_id !== null &&
    row.github_run_attempt !== null &&
    row.github_run_url ===
      `https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/${row.github_run_id}`
  );
}
