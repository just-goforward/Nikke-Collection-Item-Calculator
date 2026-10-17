import { assertUsageAllowed } from "../../shared/usageGuard";
import { sha256Hex, stableJson } from "./crypto";
import { automationOperation, requireGuardDb } from "./http-shared";
import type { FetchLike } from "./naver";
import { buildNoticeCandidate, noticeErrorCode, processNotice } from "./notice-processing";
import type { ProfileCounts } from "./profile";
import { loadRuntimeEvents } from "./runtime-events";
import {
  type IngestionEntry,
  ingestionQueue,
  ingestionSettlement,
  queueItem,
  reserveNotice,
  startIngestion,
} from "./runtime-ingestion-db";
import { processSourceQueue, readScheduleLedger } from "./source-queue";
import type { CollectorEnv, SourceQueueResult } from "./types";

export function runtimeIngestionEnabled(env: CollectorEnv) {
  return env.ENVIRONMENT === "staging" && env.RUNTIME_INGESTION_ENABLED === "true";
}

export async function runRuntimeIngestion(
  env: CollectorEnv,
  options: {
    fetcher?: FetchLike;
    candidateNowMs?: number;
    counts?: ProfileCounts;
    requireProfileAdmission?: boolean;
    requireRotationAdmission?: boolean;
  } = {},
) {
  if (!runtimeIngestionEnabled(env))
    return { outcome: "disabled" as const, processed: 0, candidateCreated: false };
  await assertUsageAllowed(requireGuardDb(env), automationOperation(env));
  const limit = Number(env.RUNTIME_NOTICE_DAILY_LIMIT ?? "20");
  // Staging's approved ceiling cannot be raised by a config typo.
  if (!Number.isInteger(limit) || limit < 0 || limit > 20)
    throw new Error("runtime_notice_daily_limit");
  const db = env.FORECAST_DB;
  const token = await startIngestion(
    db,
    options.requireProfileAdmission,
    options.requireRotationAdmission,
  );
  if (!token) return { outcome: "held" as const, processed: 0, candidateCreated: false };
  try {
    const entries = await collectNotices(env, token, limit, options.fetcher, options.counts);
    const results: SourceQueueResult[] = entries.map((entry) => entry.result);
    const candidate = await prepareNoticeCandidate(db, results, options.candidateNowMs);
    await assertUsageAllowed(requireGuardDb(env), automationOperation(env));
    const transaction = await ingestionSettlement(
      db,
      token,
      entries,
      candidate?.envelope.candidate.candidateId ?? null,
    );
    const result = await processSourceQueue(
      db,
      { mode: "bootstrap", results, candidate },
      transaction,
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
) {
  const db = env.FORECAST_DB;
  const entries: IngestionEntry[] = [];
  for (const row of await ingestionQueue(db)) {
    await assertUsageAllowed(requireGuardDb(env), automationOperation(env));
    const requestId = row.official === 1 ? await reserveNotice(db, token, row, limit) : null;
    if (row.official === 1 && requestId === null) break;
    if (requestId && counts) counts.noticesReserved += 1;
    const result = await processNotice(queueItem(row), fetcher ?? fetch, counts, db);
    entries.push({ row, result, requestId });
  }
  return entries;
}

async function prepareNoticeCandidate(
  db: D1Database,
  results: SourceQueueResult[],
  candidateNowMs: number | undefined,
) {
  if (results.length === 0) return undefined;
  const ledger = await readScheduleLedger(db, candidateNowMs ?? Date.now());
  const events = await loadRuntimeEvents(db, ledger.events);
  const unresolved = await db
    .prepare(`SELECT source,item_id FROM source_queue q
      WHERE status IN ('pending','manual_review') AND NOT EXISTS (
        SELECT 1 FROM json_each(?) r
        WHERE json_extract(r.value,'$.source')=q.source
          AND json_extract(r.value,'$.itemId')=q.item_id
          AND json_extract(r.value,'$.outcome') IN ('processed','ignored')
      ) LIMIT 1`)
    .bind(
      JSON.stringify(results.map(({ source, itemId, outcome }) => ({ source, itemId, outcome }))),
    )
    .first();
  const candidate = !unresolved
    ? await buildNoticeCandidate(events, results, candidateNowMs ?? Date.now(), ledger.nextRevision)
    : undefined;
  if (candidate && (await candidateAlreadyStored(db, candidate))) return undefined;
  return candidate;
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
