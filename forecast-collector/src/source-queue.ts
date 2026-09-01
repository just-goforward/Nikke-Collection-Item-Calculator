import { z } from "zod/mini";
import {
  assertForecastCandidateInvariants,
  supplyForecastCandidateEnvelopeSchema,
} from "../../shared/supplyForecastCandidate";
import { sha256Hex, stableJson } from "./crypto";
import {
  candidateStatements,
  loadScheduleEvents,
  nextForecastRevision,
  sourceItemAndEventStatements,
} from "./db";
import { ensureManualReviewStatement } from "./manual-review";
import { type FetchLike, fetchNaverFeedMetadata } from "./naver";
import type {
  CandidateBuildResult,
  CollectorEnv,
  NaverFeedMetadata,
  NaverSourceKind,
  NormalizedSourceItem,
  ScheduleEvent,
  SourceQueueItem,
} from "./types";

const PAGE_SIZE = 10;
const PAGE_STEP = 8;
const timestampSchema = z.string().check(z.iso.datetime({ offset: true }));
const sourceSchema = z.enum(["naver-board-48", "naver-board-56"]);
const itemSchema = z.object({
  source: sourceSchema,
  itemId: z.string().check(z.regex(/^\d{1,20}$/)),
  url: z.url(),
  title: z.string().check(z.minLength(1), z.maxLength(300)),
  excerpt: z.string().check(z.minLength(1), z.maxLength(600)),
  normalizedText: z.string().check(z.minLength(1), z.maxLength(100_000)),
  publishedAt: timestampSchema,
  contentHash: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  structured: z.literal(true),
  official: z.boolean(),
});
const eventSchema = z.object({
  eventId: z.string().check(z.minLength(1), z.maxLength(260)),
  eventType: z.enum(["solo", "cooperation", "collaboration", "schedule_change", "reward"]),
  sourceItem: itemSchema,
  startsAt: z.nullable(timestampSchema),
  endsAt: z.nullable(timestampSchema),
  scheduleStatus: z.enum(["confirmed", "estimated"]),
  manualReview: z.boolean(),
  reason: z.nullable(z.string().check(z.maxLength(160))),
});
const resultSchema = z.object({
  source: sourceSchema,
  itemId: z.string().check(z.regex(/^\d{1,20}$/)),
  outcome: z.enum(["processed", "ignored", "manual_review", "retry"]),
  errorCode: z.optional(z.string().check(z.maxLength(80))),
  item: z.optional(itemSchema),
  event: z.optional(eventSchema),
});
const sourceQueueProcessSchema = z.object({
  mode: z.enum(["queue", "bootstrap"]),
  results: z.array(resultSchema).check(z.maxLength(40)),
  candidate: z.optional(
    z.object({
      eventId: z.string().check(z.minLength(1), z.maxLength(260)),
      gameDay: z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/)),
      revision: z.number().check(z.int(), z.minimum(1)),
      envelope: supplyForecastCandidateEnvelopeSchema,
    }),
  ),
});

export class NaverPartialSchemaError extends Error {
  readonly boardId: 48 | 56;
  readonly offset: number;
  readonly rejected: Awaited<ReturnType<typeof fetchNaverFeedMetadata>>["unknownRejected"];

  constructor(
    boardId: 48 | 56,
    offset: number,
    rejected: Awaited<ReturnType<typeof fetchNaverFeedMetadata>>["unknownRejected"],
  ) {
    super("naver_partial_schema_drift");
    this.name = "NaverPartialSchemaError";
    this.boardId = boardId;
    this.offset = offset;
    this.rejected = rejected;
  }
}

export async function startInvocation(
  db: D1Database,
  deploymentSha: string,
  scheduledTime: number,
  pollMode: CollectorEnv["POLL_MODE"],
) {
  const scheduledAt = new Date(scheduledTime).toISOString();
  const invocationId = `${deploymentSha}:${scheduledTime}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO collector_invocations (
         invocation_id, deployment_sha, scheduled_at, started_at, status, poll_mode
       ) VALUES (?, ?, ?, ?, 'running', ?)`,
    )
    .bind(invocationId, deploymentSha, scheduledAt, new Date().toISOString(), pollMode)
    .run();
  return invocationId;
}

export async function finishInvocation(
  db: D1Database,
  invocationId: string,
  status: "completed" | "failure" | "circuit_open",
  queuedCount: number,
  errorCode: string | null,
  nextRetryAt: string | null,
) {
  await db
    .prepare(
      `UPDATE collector_invocations
       SET status = ?, finished_at = ?, queued_count = ?, error_code = ?, next_retry_at = ?
       WHERE invocation_id = ? AND status = 'running'`,
    )
    .bind(status, new Date().toISOString(), queuedCount, errorCode, nextRetryAt, invocationId)
    .run();
}

export async function invocationCircuitState(db: D1Database, nowMs: number) {
  const rows = await db
    .prepare(
      `SELECT status, next_retry_at FROM collector_invocations
       WHERE status <> 'running' ORDER BY scheduled_at DESC LIMIT 12`,
    )
    .all<{ status: string; next_retry_at: string | null }>();
  let failures = 0;
  for (const row of rows.results) {
    if (row.status !== "failure") break;
    failures += 1;
  }
  const nextRetryAt = rows.results[0]?.next_retry_at ?? null;
  return {
    failures,
    open: failures >= 3 && nextRetryAt !== null && Date.parse(nextRetryAt) > nowMs,
    nextRetryAt,
  };
}

export function sourcesForInvocation(mode: CollectorEnv["POLL_MODE"], scheduledTime: number) {
  if (mode === "both") return [48, 56] as const;
  return Math.floor(scheduledTime / (3 * 60 * 1000)) % 2 === 0 ? ([48] as const) : ([56] as const);
}

export async function pollNaverSource(
  db: D1Database,
  boardId: 48 | 56,
  fetcher: FetchLike = fetch,
) {
  const source = `naver-board-${boardId}` as NaverSourceKind;
  const state = await db
    .prepare(
      `SELECT committed_item_id, committed_published_at, scan_head_item_id,
              scan_head_published_at, next_offset
       FROM source_poll_state WHERE source = ?`,
    )
    .bind(source)
    .first<PollStateRow>();
  const offset = Number(state?.next_offset ?? 0);
  const metadataPage = await fetchNaverFeedMetadata(boardId, offset, fetcher);
  if (metadataPage.unknownRejected.length > 0) {
    throw new NaverPartialSchemaError(boardId, offset, metadataPage.unknownRejected);
  }
  const page = metadataPage.items;
  if (page.length === 0) throw new Error("naver_empty_feed");
  const committedIndex = state?.committed_item_id
    ? page.findIndex((item) => item.itemId === state.committed_item_id)
    : -1;
  const toQueue = state?.committed_item_id
    ? committedIndex >= 0
      ? page.slice(0, committedIndex)
      : page
    : page;
  const scanHead = offset === 0 ? page[0] : state && scanHeadFromState(state);
  const scanComplete = !state?.committed_item_id || committedIndex >= 0 || page.length < PAGE_SIZE;
  const nowIso = new Date().toISOString();
  const statements = queueStatements(db, toQueue, nowIso);
  statements.push(
    db
      .prepare(
        `INSERT INTO source_poll_state (
           source, committed_item_id, committed_published_at, scan_head_item_id,
           scan_head_published_at, next_offset, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET
           committed_item_id = excluded.committed_item_id,
           committed_published_at = excluded.committed_published_at,
           scan_head_item_id = excluded.scan_head_item_id,
           scan_head_published_at = excluded.scan_head_published_at,
           next_offset = excluded.next_offset,
           updated_at = excluded.updated_at`,
      )
      .bind(
        source,
        scanComplete
          ? (scanHead?.itemId ?? state?.committed_item_id ?? null)
          : state?.committed_item_id,
        scanComplete
          ? (scanHead?.publishedAt ?? state?.committed_published_at ?? null)
          : state?.committed_published_at,
        scanComplete ? null : (scanHead?.itemId ?? null),
        scanComplete ? null : (scanHead?.publishedAt ?? null),
        scanComplete ? 0 : offset + PAGE_STEP,
        nowIso,
      ),
  );
  await db.batch(statements);
  return toQueue.length;
}

export async function listSourceQueue(db: D1Database, limit: number) {
  const bounded = Math.max(1, Math.min(20, Math.trunc(limit)));
  const rows = await db
    .prepare(
      `SELECT source, item_id, url, title, published_at, official, status, attempts, error_code
       FROM source_queue WHERE status = 'pending'
       ORDER BY published_at ASC, item_id ASC LIMIT ?`,
    )
    .bind(bounded)
    .all<SourceQueueRow>();
  return rows.results.map(rowToQueueItem);
}

export async function readScheduleLedger(db: D1Database, nowMs: number) {
  const gameDay = gameDayKey(nowMs);
  return {
    gameDay,
    nextRevision: await nextForecastRevision(db, gameDay),
    events: await loadScheduleEvents(db),
  };
}

export async function processSourceQueue(db: D1Database, raw: unknown) {
  const request = sourceQueueProcessSchema.parse(raw);
  const nowIso = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const result of request.results) {
    await validateResult(result);
    if (request.mode === "queue") {
      const queued = await db
        .prepare("SELECT status, url, official FROM source_queue WHERE source = ? AND item_id = ?")
        .bind(result.source, result.itemId)
        .first<{ status: string; url: string; official: number }>();
      if (queued?.status !== "pending") throw new Error("source_queue_item_not_pending");
      if (
        result.item &&
        (result.item.url !== queued.url || result.item.official !== (queued.official === 1))
      ) {
        throw new Error("source_queue_metadata_mismatch");
      }
    }
    if (result.item) {
      statements.push(
        ...sourceItemAndEventStatements(
          db,
          [result.item as NormalizedSourceItem],
          result.event ? [result.event as ScheduleEvent] : [],
          nowIso,
        ),
      );
    }
    if (request.mode === "queue") {
      statements.push(queueResultStatement(db, result, nowIso));
      if (result.outcome === "manual_review" || result.outcome === "retry") {
        statements.push(
          await ensureManualReviewStatement(db, result.source, result.itemId, nowIso),
        );
      }
    }
  }
  if (request.candidate) {
    const expectedRevision = await currentRevision(db, request.candidate.gameDay);
    if (expectedRevision !== request.candidate.revision)
      throw new Error("candidate_revision_conflict");
    const { envelope, eventId, gameDay, revision } = request.candidate;
    assertForecastCandidateInvariants(envelope.candidate);
    if (!envelope.candidate.forecastId.startsWith(`supply-${gameDay}-v`)) {
      throw new Error("candidate_game_day_mismatch");
    }
    for (const evidence of envelope.candidate.sourceEvidence) {
      const url = new URL(evidence.url);
      const allowedHosts =
        evidence.source === "x-nikke-kr" ? ["x.com", "twitter.com"] : ["game.naver.com"];
      if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname)) {
        throw new Error("candidate_source_url_allowlist");
      }
    }
    if ((await sha256Hex(stableJson(envelope.candidate))) !== envelope.payloadHash) {
      throw new Error("candidate_payload_hash");
    }
    const eventKnown =
      request.results.some((entry) => entry.event?.eventId === eventId) ||
      (await db
        .prepare("SELECT event_id FROM schedule_events WHERE event_id = ?")
        .bind(eventId)
        .first());
    if (!eventKnown) throw new Error("candidate_schedule_event_missing");
    statements.push(
      ...candidateStatements(
        db,
        envelope as CandidateBuildResult,
        eventId,
        gameDay,
        revision,
        nowIso,
      ),
      db
        .prepare(
          `UPDATE forecast_candidates SET state = 'superseded', updated_at = ?
           WHERE schedule_event_id = ? AND game_day = ? AND candidate_id <> ?
             AND state IN ('crosschecked', 'x_unavailable', 'conflict', 'proposed')`,
        )
        .bind(nowIso, eventId, gameDay, envelope.candidate.candidateId),
    );
  }
  if (statements.length > 0) await db.batch(statements);
  return { processed: request.results.length, candidateCreated: Boolean(request.candidate) };
}

function queueStatements(db: D1Database, items: readonly NaverFeedMetadata[], nowIso: string) {
  return items.map((item) =>
    db
      .prepare(
        `INSERT INTO source_queue (
           source, item_id, url, title, published_at, official, status,
           attempts, first_seen_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(source, item_id) DO UPDATE SET
           url = excluded.url, title = excluded.title, published_at = excluded.published_at,
           official = excluded.official, updated_at = excluded.updated_at`,
      )
      .bind(
        item.source,
        item.itemId,
        item.url,
        item.title,
        item.publishedAt,
        item.official ? 1 : 0,
        nowIso,
        nowIso,
      ),
  );
}

function queueResultStatement(
  db: D1Database,
  result: z.infer<typeof resultSchema>,
  nowIso: string,
) {
  if (result.outcome === "retry") {
    return db
      .prepare(
        `UPDATE source_queue SET
           attempts = attempts + 1,
           status = CASE WHEN attempts + 1 >= 3 THEN 'manual_review' ELSE 'pending' END,
           error_code = ?, updated_at = ?
         WHERE source = ? AND item_id = ? AND status = 'pending'`,
      )
      .bind(sanitizeErrorCode(result.errorCode), nowIso, result.source, result.itemId);
  }
  return db
    .prepare(
      `UPDATE source_queue SET status = ?, attempts = attempts + 1,
       error_code = ?, updated_at = ?
       WHERE source = ? AND item_id = ? AND status = 'pending'`,
    )
    .bind(
      result.outcome,
      sanitizeErrorCode(result.errorCode),
      nowIso,
      result.source,
      result.itemId,
    );
}

async function validateResult(result: z.infer<typeof resultSchema>) {
  if (
    result.item &&
    (result.item.source !== result.source || result.item.itemId !== result.itemId)
  ) {
    throw new Error("source_queue_item_mismatch");
  }
  if (result.event && (!result.item || result.event.sourceItem.itemId !== result.itemId)) {
    throw new Error("source_queue_event_mismatch");
  }
  if (result.item) {
    const url = new URL(result.item.url);
    if (url.protocol !== "https:" || url.hostname !== "game.naver.com") {
      throw new Error("source_queue_url_allowlist");
    }
    if ((await sha256Hex(result.item.normalizedText)) !== result.item.contentHash) {
      throw new Error("source_queue_content_hash");
    }
  }
  if (result.outcome === "processed" && (!result.item || !result.event)) {
    throw new Error("source_queue_processed_payload");
  }
}

async function currentRevision(db: D1Database, gameDay: string) {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(revision), 0) AS revision FROM forecast_candidates WHERE game_day = ?",
    )
    .bind(gameDay)
    .first<{ revision: number }>();
  return Number(row?.revision ?? 0) + 1;
}

function scanHeadFromState(
  state: PollStateRow,
): Pick<NaverFeedMetadata, "itemId" | "publishedAt"> | undefined {
  if (!state.scan_head_item_id || !state.scan_head_published_at) return undefined;
  return {
    itemId: state.scan_head_item_id,
    publishedAt: state.scan_head_published_at,
  };
}

function rowToQueueItem(row: SourceQueueRow): SourceQueueItem {
  return {
    source: row.source,
    itemId: row.item_id,
    url: row.url,
    title: row.title,
    publishedAt: row.published_at,
    official: row.official === 1,
    status: row.status,
    attempts: row.attempts,
    errorCode: row.error_code,
  };
}

function sanitizeErrorCode(value: string | undefined) {
  if (!value) return null;
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "unknown";
}

function gameDayKey(nowMs: number) {
  return new Date(nowMs + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

type PollStateRow = {
  committed_item_id: string | null;
  committed_published_at: string | null;
  scan_head_item_id: string | null;
  scan_head_published_at: string | null;
  next_offset: number;
};

type SourceQueueRow = {
  source: NaverSourceKind;
  item_id: string;
  url: string;
  title: string;
  published_at: string;
  official: number;
  status: SourceQueueItem["status"];
  attempts: number;
  error_code: string | null;
};
