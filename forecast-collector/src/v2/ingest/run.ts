import { assertUsageAllowed } from "../../../../shared/usageGuard";
import { sha256Hex } from "../../crypto";
import { automationOperation, opsEnvironment, requireGuardDb } from "../../http-shared";
import type { FetchLike } from "../../naver";
import type { CollectorEnv } from "../../types";
import { fetchDetail, fetchMetadata, IngestFailure, type Metadata } from "./client";
import type { RulesPort } from "./rules-port";
import {
  EDIT_SCAN_INTERVAL_MS,
  METADATA_FAILURE_LIMIT,
  type Stream,
  scheduledStream,
  streams,
  v2Mode,
} from "./schedule";
import { type Lease, MonitorStore } from "./store";
import { advanceScan, type Scan, startScan } from "./traversal";

export type V2Env = CollectorEnv & {
  FORECAST_V2_MODE?: string;
  FORECAST_V2_BOOTSTRAP_CUTOFF?: string;
};
type State = {
  committed_created_at: string | null;
  committed_feed_ids_json: string;
  edit_scan_completed_at: string | null;
  edit_scan_cutoff: string | null;
};
type Run = {
  run_id: string;
  generation: number;
  kind: "new" | "edit";
  pages_used: number;
  status: string;
  started_at: string;
};
// Terminal dispositions apply to the observed version, not future edits. Keep the
// evidence row; a refreshed updatedDate is eligible for a fresh bounded attempt set.
const pendingBody = `NOT EXISTS(SELECT 1 FROM forecast_v2_post_versions v
  WHERE v.feed_id=h.feed_id AND v.updated_date=h.updated_date)
  AND NOT EXISTS(SELECT 1 FROM forecast_v2_search_hits terminal
    WHERE terminal.feed_id=h.feed_id AND terminal.updated_date=h.updated_date
      AND json_extract(terminal.metadata_json,'$.bodyDisposition') IS NOT NULL)`;
type Invocation = {
  env: V2Env;
  now: number;
  time: string;
  clock: () => string;
  db: D1Database;
  store: MonitorStore;
  guard: () => Promise<void>;
  rules: RulesPort | undefined;
  fetcher: FetchLike | undefined;
  candidate: ((env: V2Env, now: number) => Promise<unknown>) | undefined;
};
type StreamInvocation = Invocation & { stream: Stream; lease: Lease };
type AttemptState = {
  attempt: string | null;
  body: Metadata | null;
  bodyAttemptCount: number;
  metadata: { runId: string; scan: Scan } | null;
};
export async function runV2Invocation(
  env: V2Env,
  now: number,
  dependencies: {
    fetcher?: FetchLike;
    rules?: RulesPort;
    guard?: () => Promise<void>;
    candidate?: Invocation["candidate"];
  } = {},
) {
  if (v2Mode(env) === "off") return { outcome: "disabled" };
  const started = performance.now();
  const clock = () => new Date(now + performance.now() - started).toISOString();
  const rules = dependencies.rules;
  if (v2Mode(env) === "on" && !rules) return { outcome: "held", reason: "rules_unavailable" };
  const db = env.FORECAST_DB;
  const guard =
    dependencies.guard ??
    (() => assertUsageAllowed(requireGuardDb(env), automationOperation(env)).then(() => {}));
  await guard();
  const time = new Date(now).toISOString();
  const store = new MonitorStore(db, v2Mode(env) === "on" ? opsEnvironment(env) : undefined, clock);
  return dispatchUnit({
    env,
    now,
    time,
    clock,
    db,
    store,
    guard,
    rules,
    fetcher: dependencies.fetcher,
    candidate: dependencies.candidate,
  });
}

async function calendarUnit({ env, now, db, store, guard, rules }: Invocation) {
  if (v2Mode(env) !== "on" || !rules) return { outcome: "held", reason: "calendar_hold" };
  const calendarLease = await store.acquire("G", now);
  if (!calendarLease) return { outcome: "held", reason: "lease" };
  try {
    await guard();
    return { outcome: "calendar", ...(await rules.rebuildCalendar(db, now)) };
  } finally {
    await store.release(calendarLease);
  }
}

async function dispatchUnit(context: Invocation) {
  const { env, now, rules, store } = context;
  const minute = new Date(now).getUTCMinutes();
  if (minute === 57) return calendarUnit(context);
  if (v2Mode(env) === "on" && minute === 51)
    return context.candidate
      ? { outcome: "candidate", result: await context.candidate(env, now) }
      : { outcome: "held", reason: "candidate_unavailable" };
  if (v2Mode(env) === "on" && minute === 54)
    return rules?.applyPendingDecisions
      ? { outcome: "decisions", result: await rules.applyPendingDecisions(context.db, now) }
      : { outcome: "held", reason: "decisions_unavailable" };
  let stream = scheduledStream(now);
  if (!stream) {
    if ([39, 42, 48].includes(minute) && v2Mode(env) === "on" && rules) {
      const result = await rulesUnit(context, rules);
      if (result) return result;
    }
    stream = await continuationStream(context, minute);
  }
  if (!stream) return { outcome: "idle" };
  const lease = await store.acquire(stream, now);
  if (!lease) return { outcome: "held", reason: "lease" };
  return streamUnit({ ...context, stream, lease });
}

async function rulesUnit({ db, store, now, guard, clock }: Invocation, rules: RulesPort) {
  const version = await db
    .prepare(`SELECT q.version_id,v.feed_id,q.stream_id
        FROM forecast_v2_rules_queue q
        JOIN forecast_v2_post_versions v ON v.version_id=q.version_id
        WHERE q.status='pending' AND q.attempts<3
          AND (q.next_attempt_at IS NULL OR q.next_attempt_at<=?)
        ORDER BY q.attempts,q.created_at LIMIT 1`)
    .bind(new Date(now).toISOString())
    .first<{ version_id: string; feed_id: string; stream_id: Stream }>();
  if (version) {
    const ruleLease = await store.acquire(version.stream_id, now);
    if (!ruleLease) return { outcome: "held", reason: "lease" };
    try {
      await guard();
      await rules.processPostVersion(
        db,
        {
          monitorId: version.stream_id,
          feedId: version.feed_id,
          versionId: version.version_id,
        },
        now,
      );
      await guard();
      const inserted = await db
        .prepare(`UPDATE forecast_v2_rules_queue SET status='done',next_attempt_at=NULL
            WHERE version_id=? AND stream_id=? AND status='pending'
            AND EXISTS(SELECT 1 FROM forecast_v2_monitor_state
              WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?)`)
        .bind(version.version_id, version.stream_id, version.stream_id, ruleLease.owner, clock())
        .run();
      if (inserted.meta.changes !== 1) throw new IngestFailure("lease_lost");
      return { outcome: "rules_processed" };
    } catch (error) {
      await guard();
      if (error instanceof IngestFailure && error.code === "lease_lost")
        return { outcome: "held", reason: "lease_lost" };
      const recorded = await recordRulesFailure(db, store, version, now, ruleLease.owner, clock());
      if (!recorded) return { outcome: "held", reason: "lease_lost" };
      return { outcome: "held", reason: await store.hold(ruleLease, "rules_failed", now) };
    } finally {
      await store.release(ruleLease);
    }
  }
}

async function recordRulesFailure(
  db: D1Database,
  store: MonitorStore,
  version: { version_id: string; stream_id: Stream },
  now: number,
  owner: string,
  currentTime: string,
) {
  const count = await db
    .prepare(`UPDATE forecast_v2_rules_queue
      SET attempts=attempts+1,status=CASE WHEN attempts=2 THEN 'failed' ELSE 'pending' END,
        next_attempt_at=CASE attempts WHEN 0 THEN ? WHEN 1 THEN ? ELSE NULL END
      WHERE version_id=? AND stream_id=? AND status='pending' AND attempts<3
      AND EXISTS(SELECT 1 FROM forecast_v2_monitor_state
        WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?)
      RETURNING attempts AS n`)
    .bind(
      new Date(now + 15 * 60_000).toISOString(),
      new Date(now + 60 * 60_000).toISOString(),
      version.version_id,
      version.stream_id,
      version.stream_id,
      owner,
      currentTime,
    )
    .first<{ n: number }>();
  if (count && count.n >= 3) {
    await store.alert(version.stream_id, "rules_attempts_exhausted", now);
  }
  return count !== null;
}

async function continuationStream(
  { db, env, now, rules }: Invocation,
  minute: number,
): Promise<Stream | null> {
  const continuation = await db
    .prepare(`SELECT stream_id FROM forecast_v2_monitor_runs
      WHERE (status='running' OR EXISTS(SELECT 1 FROM forecast_v2_search_hits h
        WHERE h.run_id=forecast_v2_monitor_runs.run_id AND ${pendingBody})
      ) AND EXISTS(SELECT 1 FROM forecast_v2_monitor_state s
        WHERE s.stream_id=forecast_v2_monitor_runs.stream_id
          AND (s.lease_owner IS NULL OR s.lease_expires_at<=?))
      ORDER BY (SELECT s.updated_at FROM forecast_v2_monitor_state s
        WHERE s.stream_id=forecast_v2_monitor_runs.stream_id),started_at LIMIT 1`)
    .bind(new Date(now).toISOString())
    .first<{ stream_id: Stream }>();
  let stream = continuation?.stream_id ?? null;
  if (minute === 45 && v2Mode(env) === "on" && rules && (await rules.dueEFollowUps(db, now)))
    stream = "E";
  stream ??=
    (
      await db
        .prepare(`SELECT stream_id FROM forecast_v2_monitor_state
      WHERE stream_id<>'E' AND (edit_scan_completed_at IS NULL OR edit_scan_completed_at<=?)
        AND (lease_owner IS NULL OR lease_expires_at<=?)
      ORDER BY edit_scan_cutoff IS NOT NULL DESC,COALESCE(edit_scan_completed_at,''),stream_id LIMIT 1`)
        .bind(new Date(now - EDIT_SCAN_INTERVAL_MS).toISOString(), new Date(now).toISOString())
        .first<{ stream_id: Stream }>()
    )?.stream_id ?? null;
  return stream;
}

async function streamUnit(context: StreamInvocation) {
  const { db, store, lease } = context;
  const progress: AttemptState = { attempt: null, body: null, bodyAttemptCount: 0, metadata: null };
  try {
    const { state, cutoff } = await loadState(context);
    const run = await loadRun(context, state);
    const pending = await db
      .prepare(`SELECT h.metadata_json FROM forecast_v2_search_hits h
      WHERE h.run_id=? AND ${pendingBody}
      ORDER BY h.created_at,h.feed_id LIMIT 1`)
      .bind(run.run_id)
      .first<{ metadata_json: string }>();
    if (pending)
      return await bodyUnit(context, run, JSON.parse(pending.metadata_json) as Metadata, progress);
    return await metadataUnit(context, run, state, cutoff, progress);
  } catch (error) {
    return await holdUnit(context, progress, error);
  } finally {
    await store.release(lease);
  }
}

async function loadState({ db, stream, env, time }: StreamInvocation) {
  const state = await db
    .prepare(`SELECT * FROM forecast_v2_monitor_state WHERE stream_id=?`)
    .bind(stream)
    .first<State>();
  if (!state) throw new IngestFailure("state_missing");
  const cutoff = state.committed_created_at ?? env.FORECAST_V2_BOOTSTRAP_CUTOFF;
  if (
    !cutoff ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cutoff) ||
    !Number.isFinite(Date.parse(cutoff)) ||
    cutoff > time
  )
    throw new IngestFailure("bootstrap_cutoff");
  return { state, cutoff };
}

async function loadRun(
  { db, stream, now, time, clock, guard, lease }: StreamInvocation,
  state: State,
) {
  let run = await db
    .prepare(`SELECT * FROM forecast_v2_monitor_runs
      WHERE stream_id=? AND (status='running' OR EXISTS(SELECT 1 FROM forecast_v2_search_hits h
        WHERE h.run_id=forecast_v2_monitor_runs.run_id AND ${pendingBody}))
      ORDER BY generation DESC LIMIT 1`)
    .bind(stream)
    .first<Run>();
  if (!run) {
    const generation =
      ((
        await db
          .prepare(`SELECT MAX(generation) AS n FROM forecast_v2_monitor_runs
        WHERE stream_id=?`)
          .bind(stream)
          .first<{ n: number | null }>()
      )?.n ?? 0) + 1;
    const kind = state.edit_scan_cutoff
      ? "edit"
      : scheduledStream(now) || !state.committed_created_at || stream === "E"
        ? "new"
        : "edit";
    run = {
      run_id: crypto.randomUUID(),
      generation,
      kind,
      pages_used: 0,
      status: "running",
      started_at: time,
    };
    await guard();
    const inserted = await db
      .prepare(`INSERT INTO forecast_v2_monitor_runs(run_id,stream_id,generation,kind,status,started_at)
        SELECT ?,?,?,?,'running',? WHERE EXISTS(SELECT 1 FROM forecast_v2_monitor_state
          WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?)`)
      .bind(run.run_id, stream, generation, kind, time, stream, lease.owner, clock())
      .run();
    if (inserted.meta.changes !== 1) throw new IngestFailure("lease_lost");
  }
  return run;
}

async function bodyUnit(
  { db, store, stream, lease, now, time, clock, guard, fetcher }: StreamInvocation,
  run: Run,
  metadata: Metadata,
  progress: AttemptState,
) {
  progress.body = metadata;
  const prior = await store.bodyAttempts(metadata);
  progress.bodyAttemptCount = prior.count;
  if (prior.count >= 3) throw new IngestFailure("attempts_exhausted");
  if (prior.next && prior.next > time) throw new IngestFailure("retry_backoff");
  progress.attempt = await store.reserve(lease, run.run_id, "detail", now, metadata.feedId);
  progress.bodyAttemptCount++;
  const detail = await fetchDetail(stream, metadata, fetcher);
  const hash = await sha256Hex(detail.bodyText);
  const versionId = `${metadata.feedId}:${hash}:${metadata.updatedAt}`;
  await guard();
  const inserted = await db
    .prepare(`INSERT INTO forecast_v2_post_versions
        (version_id,feed_id,updated_date,content_hash,board_id,created_at,fetched_at,body_text)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM forecast_v2_monitor_state
          WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?) ON CONFLICT DO NOTHING`)
    .bind(
      versionId,
      metadata.feedId,
      metadata.updatedAt,
      hash,
      streams[stream].board,
      metadata.createdAt,
      time,
      detail.bodyText,
      stream,
      lease.owner,
      clock(),
    )
    .run();
  if (inserted.meta.changes !== 1) {
    const alreadyStored = await db
      .prepare(`SELECT 1 FROM forecast_v2_post_versions WHERE version_id=?
          AND EXISTS(SELECT 1 FROM forecast_v2_monitor_state
            WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?)`)
      .bind(versionId, stream, lease.owner, clock())
      .first();
    if (!alreadyStored) throw new IngestFailure("lease_lost");
  }
  await store.finishAttempt(progress.attempt, null, now);
  return { outcome: "body_stored", versionId };
}

async function metadataUnit(
  { db, store, stream, lease, now, clock, guard, fetcher }: StreamInvocation,
  run: Run,
  state: State,
  cutoff: string,
  progress: AttemptState,
) {
  const prior = await store.metadataAttempts(run.run_id);
  if (prior.failures < METADATA_FAILURE_LIMIT && prior.next && prior.next > clock())
    throw new IngestFailure("retry_backoff");
  const hits = await db
    .prepare(`SELECT metadata_json FROM forecast_v2_search_hits WHERE run_id=?
      ORDER BY created_at DESC,feed_id`)
    .bind(run.run_id)
    .all<{ metadata_json: string }>();
  const rows = hits.results.map((row) => JSON.parse(row.metadata_json) as Metadata);
  const scanCutoff =
    run.kind === "edit"
      ? new Date(Date.parse(run.started_at) - 14 * 86_400_000).toISOString()
      : cutoff;
  const scan: Scan = {
    ...startScan(
      {
        createdAt: scanCutoff,
        feedIds: run.kind === "edit" ? [] : JSON.parse(state.committed_feed_ids_json),
      },
      run.kind,
    ),
    page: run.pages_used,
    hits: rows,
    seenBoundaryIds: rows.filter((row) => row.createdAt === scanCutoff).map((row) => row.feedId),
    lastCreatedAt: rows.at(-1)?.createdAt ?? null,
  };
  progress.metadata = { runId: run.run_id, scan };
  if (prior.failures >= METADATA_FAILURE_LIMIT)
    throw new IngestFailure("metadata_attempts_exhausted");
  progress.attempt = await store.reserve(lease, run.run_id, "metadata", now);
  const page = await fetchMetadata(stream, scan.page, fetcher);
  const next = advanceScan(scan, page, stream);
  // Persistence failures are not upstream-page failures and must not rewind a
  // page that may already have committed.
  progress.metadata = null;
  await guard();
  await store.commitPage(lease, run.run_id, next, now, clock());
  await store.finishAttempt(progress.attempt, null, now);
  if (next.status === "held") {
    if (!next.reason) throw new IngestFailure("hold_reason_missing");
    return { outcome: "held", reason: await store.hold(lease, next.reason, now) };
  }
  if (next.reason === "boundary_reseeded") await store.alert(stream, next.reason, now);
  return next.reason ? { outcome: next.status, reason: next.reason } : { outcome: next.status };
}

async function holdUnit(
  { db, store, stream, lease, clock, now, guard }: StreamInvocation,
  progress: AttemptState,
  error: unknown,
) {
  const { attempt, metadata } = progress;
  let failure = error instanceof IngestFailure ? error : new IngestFailure("unit_failed");
  await guard();
  // Waiting is not a failed request and must not increment hold/alert counters.
  if (failure.code === "retry_backoff") return { outcome: "held", reason: failure.code };
  if (failure.code === "budget_or_lease") {
    const owned = await db
      .prepare(`SELECT 1 FROM forecast_v2_monitor_state
        WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?`)
      .bind(stream, lease.owner, clock())
      .first();
    failure = new IngestFailure(owned ? "budget_exhausted" : "lease_lost");
  }
  try {
    if (attempt) await store.finishAttempt(attempt, failure, now);
    if (
      metadata &&
      (await store.metadataAttempts(metadata.runId)).failures >= METADATA_FAILURE_LIMIT
    ) {
      failure = new IngestFailure("metadata_attempts_exhausted");
      await store.commitPage(
        lease,
        metadata.runId,
        { ...metadata.scan, status: "held", reason: failure.code },
        now,
        clock(),
      );
    }
    failure = await disposeFailedBody(store, lease, progress, failure, now);
  } catch (recordingError) {
    const originalReason = failure.code;
    failure =
      recordingError instanceof IngestFailure
        ? recordingError
        : new IngestFailure("failure_recording_failed");
    console.error(
      JSON.stringify({
        event: "forecast_v2_failure_recording_failed",
        stream,
        originalReason,
        reason: failure.code,
      }),
    );
  }
  return { outcome: "held", reason: await store.hold(lease, failure.code, now) };
}

async function disposeFailedBody(
  store: MonitorStore,
  lease: Lease,
  { body, bodyAttemptCount }: AttemptState,
  failure: IngestFailure,
  now: number,
) {
  if (body) {
    if (failure.code === "detail_drift" || failure.code === "http_404") {
      await store.disposeBody(
        lease,
        body,
        failure.code === "http_404" ? "deleted" : "refresh",
        failure.code,
        now,
      );
    } else if (bodyAttemptCount >= 3 && failure.code !== "lease_lost") {
      await store.disposeBody(lease, body, "failed", failure.code, now);
      failure = new IngestFailure("attempts_exhausted");
    }
  }
  return failure;
}
