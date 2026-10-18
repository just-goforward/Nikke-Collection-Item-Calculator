import { gameDayStartMs } from "../../shared/gameDay";
import { assertUsageAllowed } from "../../shared/usageGuard";
import { board11InvocationGate } from "./board11-policy";
import { resolveSoloSchedule } from "./candidate";
import { sha256Hex, stableJson } from "./crypto";
import { loadGrants } from "./grants";
import { automationOperation, requireGuardDb } from "./http-shared";
import type { FetchLike } from "./naver";
import { buildNoticeCandidate, noticeErrorCode, processNotice } from "./notice-processing";
import type { ProfileCounts } from "./profile";
import {
  persistedReviewEvidence,
  publicationExclusionStatements,
  type ReviewEvidence,
} from "./publication-exclusions";
import { loadRuntimeEvents } from "./runtime-events";
import {
  type IngestionEntry,
  ingestionQueue,
  ingestionSettlement,
  queueItem,
  reserveNotice,
  startIngestion,
} from "./runtime-ingestion-db";
import { readScheduleLedger } from "./schedule-ledger";
import { processSourceQueue } from "./source-queue";
import type { CollectorEnv, SourceQueueResult } from "./types";

export function runtimeIngestionEnabled(env: CollectorEnv) {
  return env.ENVIRONMENT === "staging" && env.RUNTIME_INGESTION_ENABLED === "true";
}

export function runRuntimeCandidate(env: CollectorEnv, candidateNowMs?: number) {
  return runRuntimeInvocation(env, { candidateNowMs: candidateNowMs ?? Date.now() }, true);
}

export function runRuntimeIngestion(env: CollectorEnv, options: RuntimeOptions = {}) {
  return runRuntimeInvocation(env, options, false);
}

type RuntimeOptions = {
  fetcher?: FetchLike;
  candidateNowMs?: number;
  counts?: ProfileCounts;
  requireProfileAdmission?: boolean;
  requireRotationAdmission?: boolean;
};

async function runRuntimeInvocation(
  env: CollectorEnv,
  options: RuntimeOptions,
  candidateOnly: boolean,
) {
  if (!runtimeIngestionEnabled(env))
    return { outcome: "disabled" as const, processed: 0, candidateCreated: false };
  await assertUsageAllowed(requireGuardDb(env), automationOperation(env));
  const limit = Number(env.RUNTIME_NOTICE_DAILY_LIMIT ?? "20");
  // Staging's approved ceiling cannot be raised by a config typo.
  if (!Number.isInteger(limit) || limit < 0 || limit > 20)
    throw new Error("runtime_notice_daily_limit");
  const db = env.FORECAST_DB;
  // Check before claiming a lease: incomplete migrations are a disabled path,
  // not repeated failed ingestion runs. Object presence alone is not admission.
  if (
    candidateOnly &&
    !(await db
      .prepare(
        "SELECT COUNT(*) AS versions FROM schema_migrations WHERE version IN (28,29) HAVING COUNT(*)=2",
      )
      .first())
  )
    return { outcome: "disabled" as const, processed: 0, candidateCreated: false };
  const board11Allowed = board11InvocationGate(db);
  const token = await startIngestion(
    db,
    options.requireProfileAdmission,
    options.requireRotationAdmission,
    candidateOnly,
  );
  if (!token) return { outcome: "held" as const, processed: 0, candidateCreated: false };
  // No schedule writes occur before settlement. Notice judgments share a lazy
  // snapshot; publication reads a fresh persisted snapshot in its own invocation.
  let ledgerPromise: Promise<Awaited<ReturnType<typeof readScheduleLedger>>> | undefined;
  const readLedger = () =>
    (ledgerPromise ??= (async () => {
      const ledger = await readScheduleLedger(db, options.candidateNowMs ?? Date.now());
      return { ...ledger, events: await loadRuntimeEvents(db, ledger.events) };
    })());
  try {
    const entries = candidateOnly
      ? []
      : await collectNotices(
          env,
          token,
          limit,
          options.fetcher,
          options.counts,
          board11Allowed,
          async () => (await readLedger()).events,
        );
    const results: SourceQueueResult[] = entries.map((entry) => entry.result);
    const exclusionStatements: D1PreparedStatement[] = [];
    const candidate = candidateOnly
      ? await prepareNoticeCandidate(
          db,
          options.candidateNowMs,
          board11Allowed,
          readLedger,
          exclusionStatements,
          token,
          env.DEPLOY_SHA,
        )
      : undefined;
    await assertUsageAllowed(requireGuardDb(env), automationOperation(env));
    const transaction = await ingestionSettlement(
      db,
      token,
      entries,
      candidate?.envelope.candidate.candidateId ?? null,
      board11Allowed,
    );
    const result = await processSourceQueue(
      db,
      { mode: "bootstrap", results, candidate },
      { before: transaction.before, after: [...exclusionStatements, ...transaction.after] },
      board11Allowed,
    );
    return { outcome: "completed" as const, ...result };
  } catch (error) {
    await db
      .prepare(`UPDATE runtime_ingestion_runs SET status='failed',finished_at=?,error_code=?
      WHERE token=? AND status='running'`)
      .bind(new Date().toISOString(), noticeErrorCode(error), token)
      .run();
    throw error;
  }
}

async function collectNotices(
  env: CollectorEnv,
  token: string,
  limit: number,
  fetcher: FetchLike | undefined,
  counts?: ProfileCounts,
  board11Allowed = board11InvocationGate(env.FORECAST_DB),
  knownEvents?: () => Promise<Awaited<ReturnType<typeof loadRuntimeEvents>>>,
) {
  const db = env.FORECAST_DB;
  const entries: IngestionEntry[] = [];
  for (const row of await ingestionQueue(db)) {
    if (row.source === "naver-board-11" && !(await board11Allowed())) continue;
    await assertUsageAllowed(requireGuardDb(env), automationOperation(env));
    const requestId =
      row.official === 1 ? await reserveNotice(db, token, row, limit, board11Allowed) : null;
    if (row.official === 1 && requestId === null) break;
    if (requestId && counts) counts.noticesReserved += 1;
    const result = await processNotice(
      queueItem(row),
      fetcher ?? fetch,
      counts,
      db,
      board11Allowed,
      knownEvents,
    );
    entries.push({ row, result, requestId });
  }
  return entries;
}

async function prepareNoticeCandidate(
  db: D1Database,
  candidateNowMs: number | undefined,
  board11Allowed: () => Promise<boolean>,
  readLedger: () => Promise<Awaited<ReturnType<typeof readScheduleLedger>>>,
  exclusionStatements: D1PreparedStatement[],
  token: string,
  deploymentSha: string,
) {
  if (!(await board11Allowed())) return undefined;
  // Empty invocations must not load a ledger or allocate/read a revision.
  if (!(await db.prepare("SELECT 1 FROM schedule_events LIMIT 1").first())) return undefined;
  const ledger = await readLedger();
  const events = ledger.events;
  const unresolved = await db
    .prepare(`SELECT source,item_id,status FROM source_queue
      WHERE status IN ('pending','manual_review')`)
    .all<{ source: string; item_id: string; status: string }>();
  if (unresolved.results.some((row) => row.status === "pending")) return undefined;
  const reviews: ReviewEvidence[] = [];
  for (const row of unresolved.results) {
    const review = await persistedReviewEvidence(db, row.source, row.item_id);
    if (!review) return undefined;
    reviews.push(review);
  }
  const now = candidateNowMs ?? Date.now();
  const grants = await loadGrants(db);
  const resolved = resolveSoloSchedule(events, now);
  // Cache constructor inputs, not timestamps or row counts alone. Resolving the
  // inexpensive schedule also detects coverage/focus changes within a game day.
  // Segmented schedules have additional primary-period boundaries: fail open to
  // reconstruction for those rather than approximate their temporal identity.
  const cacheable = resolved && !events.some((event) => event.segment || event.segments);
  const commits = await db
    .prepare(`SELECT COUNT(*) AS count FROM runtime_ingestion_commits
    WHERE run_token NOT LIKE 'candidate:%' AND json_array_length(queue_snapshot)>0`)
    .first();
  const reviewState = await db
    .prepare("SELECT * FROM source_manual_reviews ORDER BY review_id")
    .all();
  const bindings = await db
    .prepare(
      "SELECT review_id,generation,review_token FROM source_manual_review_bindings ORDER BY review_id",
    )
    .all();
  const signature = cacheable
    ? await sha256Hex(
        stableJson({
          gameDay: gameDayStartMs(now),
          deploymentSha,
          events,
          resolved,
          grants,
          reviews,
          commits,
          reviewState: reviewState.results,
          bindings: bindings.results,
        }),
      )
    : null;
  if (signature) {
    const cached = await db
      .prepare(`SELECT f.payload_json,c.payload_hash,f.payload_hash AS stored_payload_hash,
        f.forecast_id FROM runtime_candidate_cache c
      JOIN runtime_ingestion_runs r ON r.token=c.run_token
      JOIN forecast_candidates f ON f.candidate_id=c.candidate_id
      WHERE c.signature=? AND r.status='completed'`)
      .bind(signature)
      .first<{
        payload_json: string;
        payload_hash: string;
        stored_payload_hash: string;
        forecast_id: string;
      }>();
    if (cached) {
      await assertCachedPayload(cached);
      return undefined;
    }
  }
  const candidate = await buildNoticeCandidate(
    events,
    [],
    now,
    ledger.nextRevision,
    grants,
    reviews,
  );
  exclusionStatements.push(...publicationExclusionStatements(db, reviews));
  if (signature && candidate)
    exclusionStatements.push(
      db
        .prepare(`INSERT INTO runtime_candidate_cache VALUES(1,?,?,?,
          (SELECT payload_hash FROM forecast_candidates WHERE candidate_id=?))
      ON CONFLICT(singleton) DO UPDATE SET signature=excluded.signature,run_token=excluded.run_token,
        candidate_id=excluded.candidate_id,payload_hash=excluded.payload_hash`)
        .bind(
          signature,
          token,
          candidate.envelope.candidate.candidateId,
          candidate.envelope.candidate.candidateId,
        ),
    );
  if (candidate && (await candidateAlreadyStored(db, candidate))) return undefined;
  return candidate;
}

async function assertCachedPayload(cached: {
  payload_json: string;
  payload_hash: string;
  stored_payload_hash: string;
  forecast_id: string;
}) {
  const payload = JSON.parse(cached.payload_json);
  if (
    cached.payload_hash !== cached.stored_payload_hash ||
    payload.forecastId !== cached.forecast_id ||
    (await sha256Hex(stableJson(payload))) !== cached.payload_hash
  )
    throw new Error("runtime_candidate_identity_conflict");
}

async function candidateAlreadyStored(
  db: D1Database,
  candidate: NonNullable<Awaited<ReturnType<typeof buildNoticeCandidate>>>,
) {
  const existing = await db
    .prepare(
      "SELECT forecast_id,payload_json,payload_hash FROM forecast_candidates WHERE candidate_id=?",
    )
    .bind(candidate.envelope.candidate.candidateId)
    .first<{ forecast_id: string; payload_json: string; payload_hash: string }>();
  if (!existing) return false;
  // Candidate identity is independent of the day's revision. Replaying
  // unchanged content must not allocate a new revision or rewrite bytes.
  // The profile builder's only revision-dependent value is its ID:
  // `${forecastId}@${effectiveFrom}`. Reuse the exact derived gains.
  const replay = {
    ...candidate.envelope.candidate,
    forecastId: existing.forecast_id,
    profiles: candidate.envelope.candidate.profiles.map((profile) => ({
      ...profile,
      id: `${existing.forecast_id}@${profile.effectiveFrom}`,
    })),
  };
  const replayJson = stableJson(replay);
  if (
    (await sha256Hex(replayJson)) !== existing.payload_hash ||
    stableJson(JSON.parse(existing.payload_json)) !== replayJson
  ) {
    throw new Error("runtime_candidate_identity_conflict");
  }
  return true;
}
