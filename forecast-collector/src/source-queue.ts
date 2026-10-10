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
import { type FetchLike, fetchNaverFeedMetadata, fetchNaverItemIdentity } from "./naver";
import {
  coveredBoundaryTail,
  NAVER_PAGE_SIZE,
  NAVER_RECOVERY_PAGES,
  NAVER_SCAN_PAGES,
  orderedOfficialBoundaryItems,
  samePublicationTime,
} from "./naver-boundary-proof";
import { type OpsEnvironment, upsertOpsAlertStatement } from "./ops";
import type {
  CandidateBuildResult,
  CollectorEnv,
  NaverFeedMetadata,
  NaverSourceKind,
  NormalizedSourceItem,
  ScheduleEvent,
  SourceQueueItem,
} from "./types";

const PAGE_SIZE = NAVER_PAGE_SIZE;
const PAGE_STEP = 1;
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
const boundaryRecoverySchema = z.object({
  mode: z.literal("recover-boundary"),
  environment: z.enum(["staging", "production"]),
  source: sourceSchema,
  expectedCommittedItemId: z.string().check(z.regex(/^\d{1,20}$/)),
});
const recoveryGuardSql = `EXISTS (
  SELECT 1 FROM forecast_ops_alerts
  WHERE alert_key = ? AND environment = ? AND state = 'resolved'
    AND json_extract(context_json, '$.recoveryId') = ?
)`;

type BoundaryHoldProof = {
  board: number;
  committedItemId: string | null;
  committedPublishedAt: string | null;
  scanHeadItemId: string | null;
  scanHeadPublishedAt: string | null;
};

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

export class NaverScanBoundaryError extends Error {
  constructor(readonly queuedItems: number) {
    super("naver_scan_boundary_missing");
    this.name = "NaverScanBoundaryError";
  }
}

export class NaverBoundaryHeldError extends Error {
  constructor() {
    super("naver_boundary_held");
    this.name = "NaverBoundaryHeldError";
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
      `SELECT status, next_retry_at, error_code FROM collector_invocations
       WHERE status IN ('failure', 'completed')
         AND (error_code IS NULL OR error_code <> 'naver_boundary_held_only')
       ORDER BY scheduled_at DESC LIMIT 12`,
    )
    .all<{ status: string; next_retry_at: string | null; error_code: string | null }>();
  let failures = 0;
  for (const row of rows.results) {
    if (
      row.status !== "failure" ||
      row.error_code === "naver_scan_boundary_missing" ||
      row.error_code === "naver_boundary_held"
    )
      break;
    failures += 1;
  }
  const nextRetryAt = failures > 0 ? (rows.results[0]?.next_retry_at ?? null) : null;
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
  environment: OpsEnvironment = "staging",
) {
  const source = `naver-board-${boardId}` as NaverSourceKind;
  const state = await readPollState(db, source);
  if (await readBoundaryHold(db, boardId, environment)) {
    return recoverMovedNaverBoundary(db, boardId, state, environment, fetcher);
  }
  const offset = Number(state?.next_offset ?? 0);
  // Legacy row-index offsets (8, 16, ... 104) are not page cursors.
  if (!Number.isInteger(offset) || offset < 0 || offset >= NAVER_SCAN_PAGES) {
    throw new Error("source_cursor_recovery_required");
  }
  const metadataPage = await fetchNaverFeedMetadata(boardId, offset, fetcher);
  if (metadataPage.unknownRejected.length > 0) {
    throw new NaverPartialSchemaError(boardId, offset, metadataPage.unknownRejected);
  }
  const page = metadataPage.items;
  if (metadataPage.rawFeedCount === 0 && offset === 0) throw new Error("naver_empty_feed");
  const committedIndex = state?.committed_item_id
    ? page.findIndex((item) => item.itemId === state.committed_item_id)
    : -1;
  const toQueue =
    state?.committed_item_id && committedIndex >= 0 ? page.slice(0, committedIndex) : page;
  const scanHead = offset === 0 ? page[0] : ((state && scanHeadFromState(state)) ?? page[0]);
  const scanComplete = committedIndex >= 0 || (!state?.committed_item_id && scanHead !== undefined);
  const scanEnded =
    scanComplete || metadataPage.rawFeedCount < PAGE_SIZE || offset + 1 >= NAVER_SCAN_PAGES;
  const boundaryMissing = !scanComplete && scanEnded;
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
          : (state?.committed_item_id ?? null),
        scanComplete
          ? (scanHead?.publishedAt ?? state?.committed_published_at ?? null)
          : (state?.committed_published_at ?? null),
        scanComplete ? null : (scanHead?.itemId ?? null),
        scanComplete ? null : (scanHead?.publishedAt ?? null),
        scanEnded ? 0 : offset + PAGE_STEP,
        nowIso,
      ),
  );
  if (boundaryMissing) {
    statements.push(
      upsertOpsAlertStatement(db, {
        alertKey: boundaryHoldKey(boardId, environment),
        environment,
        severity: "critical",
        component: "naver-metadata",
        errorCode: "naver_scan_boundary_missing",
        context: {
          board: boardId,
          committedItemId: state?.committed_item_id ?? null,
          committedPublishedAt: state?.committed_published_at ?? null,
          scanHeadItemId: scanHead?.itemId ?? null,
          scanHeadPublishedAt: scanHead?.publishedAt ?? null,
          terminalOffset: offset,
          rawFeedCount: metadataPage.rawFeedCount,
          recognizedSkippedCount: metadataPage.recognizedSkipped.length,
        },
      }),
    );
  }
  await db.batch(statements);
  if (boundaryMissing) throw new NaverScanBoundaryError(toQueue.length);
  return toQueue.length;
}

export async function recoverNaverBoundary(
  db: D1Database,
  environment: OpsEnvironment,
  raw: unknown,
  fetcher: FetchLike = fetch,
  movedIdentity?: Awaited<ReturnType<typeof fetchNaverItemIdentity>>,
) {
  const request = boundaryRecoverySchema.parse(raw);
  if (request.environment !== environment) throw new Error("naver_boundary_environment_mismatch");
  const boardId = request.source === "naver-board-48" ? 48 : 56;
  const state = await readPollState(db, request.source);
  const hold = await readBoundaryHold(db, boardId, environment);
  if (!state || !hold) throw new Error("naver_boundary_not_held");
  const proof = JSON.parse(hold.context_json) as BoundaryHoldProof;
  if (
    state.committed_item_id !== request.expectedCommittedItemId ||
    proof.committedItemId !== request.expectedCommittedItemId ||
    proof.board !== boardId
  ) {
    throw new Error("naver_boundary_marker_conflict");
  }
  if (!movedIdentity) assertRecoverySnapshotProof(state, proof);
  const items = await readBoundaryRecoveryPages(
    db,
    boardId,
    state,
    fetcher,
    Boolean(movedIdentity),
  );
  const scanHead = items[0];
  if (!scanHead) throw new NaverScanBoundaryError(0);
  const toQueue = boundaryRecoveryItems(
    items,
    state,
    request.expectedCommittedItemId,
    boardId,
    proof,
    movedIdentity,
  );
  const nowIso = new Date().toISOString();
  const recovery = {
    alertKey: boundaryHoldKey(boardId, environment),
    environment,
    recoveryId: crypto.randomUUID(),
  };
  const guardBindings = [recovery.alertKey, environment, recovery.recoveryId];
  const results = await db.batch([
    db
      .prepare(
        `UPDATE forecast_ops_alerts
         SET state = 'resolved', resolved_at = ?, next_send_at = ?,
             context_json = json_set(
               context_json, '$.recoveryId', ?, '$.recoveredHeadItemId', ?,
               '$.recoveryReason', ?, '$.movedBoardId', ?
             )
         WHERE alert_key = ? AND environment = ? AND state = 'open' AND context_json = ?
           AND EXISTS (
             SELECT 1 FROM source_poll_state
             WHERE source = ? AND committed_item_id = ? AND committed_published_at IS ?
               AND scan_head_item_id IS ? AND scan_head_published_at IS ?
               AND next_offset = ? AND updated_at = ?
           )`,
      )
      .bind(
        nowIso,
        nowIso,
        recovery.recoveryId,
        scanHead.itemId,
        movedIdentity ? "verified_board_change" : "boundary_found",
        movedIdentity?.boardId ?? null,
        recovery.alertKey,
        environment,
        hold.context_json,
        request.source,
        request.expectedCommittedItemId,
        state.committed_published_at,
        state.scan_head_item_id,
        state.scan_head_published_at,
        state.next_offset,
        state.updated_at,
      ),
    ...queueStatements(db, toQueue, nowIso, recovery),
    db
      .prepare(
        `UPDATE source_poll_state
         SET committed_item_id = ?, committed_published_at = ?, scan_head_item_id = NULL,
             scan_head_published_at = NULL, next_offset = 0, updated_at = ?
         WHERE source = ? AND ${recoveryGuardSql}`,
      )
      .bind(scanHead.itemId, scanHead.publishedAt, nowIso, request.source, ...guardBindings),
  ]);
  if (results[0]?.meta.changes !== 1) throw new Error("naver_boundary_recovery_conflict");
  return { recovered: true, source: request.source, queuedItems: toQueue.length };
}

function assertRecoverySnapshotProof(state: PollStateRow, proof: BoundaryHoldProof) {
  if (
    !samePublicationTime(proof.committedPublishedAt, state.committed_published_at) ||
    proof.scanHeadItemId !== state.scan_head_item_id ||
    proof.scanHeadPublishedAt !== state.scan_head_published_at
  )
    throw new Error("naver_boundary_marker_conflict");
}

async function readBoundaryRecoveryPages(
  db: D1Database,
  boardId: 48 | 56,
  state: PollStateRow,
  fetcher: FetchLike,
  moved: boolean,
) {
  const source = `naver-board-${boardId}` as NaverSourceKind;
  const items: NaverFeedMetadata[] = [];
  const deadline = AbortSignal.timeout(40_000);
  const boundedFetch: FetchLike = (input, init) =>
    fetcher(input, {
      ...init,
      signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]),
    });
  try {
    for (let offset = 0; offset < (moved ? 1 : NAVER_RECOVERY_PAGES); offset += PAGE_STEP) {
      const page = await fetchNaverFeedMetadata(boardId, offset, boundedFetch);
      if (page.unknownRejected.length > 0)
        throw new NaverPartialSchemaError(boardId, offset, page.unknownRejected);
      if (page.rawFeedCount > PAGE_SIZE) throw new NaverScanBoundaryError(0);
      items.push(...page.items);
      if (moved) return items;
      if (!orderedOfficialBoundaryItems(items, source, Date.now()))
        throw new NaverScanBoundaryError(0);
      const marker = items.find((item) => item.itemId === state.committed_item_id);
      if (marker && !samePublicationTime(marker.publishedAt, state.committed_published_at))
        throw new NaverScanBoundaryError(0);
      if (marker) {
        const knownTail = await db
          .prepare("SELECT 1 FROM source_queue WHERE source = ? AND item_id = ?")
          .bind(source, page.items.at(-1)?.itemId ?? "")
          .first();
        if (
          coveredBoundaryTail(page.items, page.rawFeedCount, marker.publishedAt, Boolean(knownTail))
        ) {
          deadline.throwIfAborted();
          return items;
        }
      }
      if (page.rawFeedCount < PAGE_SIZE) break;
    }
  } catch (error) {
    if (deadline.aborted) throw new Error("naver_timeout");
    throw error;
  }
  throw new NaverScanBoundaryError(0);
}

async function recoverMovedNaverBoundary(
  db: D1Database,
  boardId: 48 | 56,
  state: PollStateRow | null,
  environment: OpsEnvironment,
  fetcher: FetchLike,
) {
  if (
    !state?.committed_item_id ||
    !state.committed_published_at ||
    !state.scan_head_published_at ||
    Date.parse(state.scan_head_published_at) >= Date.parse(state.committed_published_at)
  ) {
    throw new NaverBoundaryHeldError();
  }
  let identity: Awaited<ReturnType<typeof fetchNaverItemIdentity>>;
  try {
    identity = await fetchNaverItemIdentity(state.committed_item_id, fetcher);
  } catch (error) {
    if (isUnavailableIdentityProof(error)) throw new NaverBoundaryHeldError();
    throw error;
  }
  if (identity.boardId === boardId) throw new NaverBoundaryHeldError();
  try {
    const recovered = await recoverNaverBoundary(
      db,
      environment,
      {
        mode: "recover-boundary",
        environment,
        source: `naver-board-${boardId}`,
        expectedCommittedItemId: state.committed_item_id,
      },
      fetcher,
      identity,
    );
    return recovered.queuedItems;
  } catch (error) {
    if (
      error instanceof Error &&
      [
        "naver_boundary_not_held",
        "naver_boundary_marker_conflict",
        "naver_boundary_recovery_conflict",
      ].includes(error.message)
    ) {
      throw new NaverBoundaryHeldError();
    }
    throw error;
  }
}

function isUnavailableIdentityProof(error: unknown) {
  if (!(error instanceof Error)) return false;
  return (
    [
      "naver_detail_schema_code",
      "naver_detail_schema_content",
      "naver_detail_identity",
      "naver_date",
      "naver_content_type",
      "naver_malformed_json",
      "naver_response_oversize",
    ].includes(error.message) ||
    (/^naver_http_4\d{2}$/.test(error.message) && error.message !== "naver_http_429")
  );
}

function boundaryRecoveryItems(
  items: readonly NaverFeedMetadata[],
  state: PollStateRow,
  expectedItemId: string,
  boardId: 48 | 56,
  proof: BoundaryHoldProof,
  movedIdentity?: Awaited<ReturnType<typeof fetchNaverItemIdentity>>,
) {
  let index = items.findIndex((item) => item.itemId === expectedItemId);
  if (movedIdentity) {
    if (
      index >= 0 ||
      movedIdentity.itemId !== expectedItemId ||
      movedIdentity.boardId === boardId ||
      !movedIdentity.official ||
      movedIdentity.publishedAt !== state.committed_published_at ||
      proof.committedPublishedAt !== state.committed_published_at ||
      proof.scanHeadItemId !== state.scan_head_item_id ||
      proof.scanHeadPublishedAt !== state.scan_head_published_at
    ) {
      throw new NaverScanBoundaryError(0);
    }
    index = items.findIndex(
      (item) =>
        item.itemId === state.scan_head_item_id &&
        item.publishedAt === state.scan_head_published_at,
    );
  }
  if (
    index < 0 ||
    (!movedIdentity &&
      !samePublicationTime(items[index]?.publishedAt ?? null, state.committed_published_at))
  )
    throw new NaverScanBoundaryError(0);
  if (movedIdentity) return items.slice(0, index);
  // Retain unseen members of the marker's equal-date cohort as well.
  return items.filter(
    (item, position) =>
      position < index ||
      (position > index && samePublicationTime(item.publishedAt, state.committed_published_at)),
  );
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

function queueStatements(
  db: D1Database,
  items: readonly NaverFeedMetadata[],
  nowIso: string,
  recovery?: { alertKey: string; environment: OpsEnvironment; recoveryId: string },
) {
  return items.map((item) =>
    db
      .prepare(
        `INSERT INTO source_queue (
           source, item_id, url, title, published_at, official, status,
           attempts, first_seen_at, updated_at
         ) SELECT ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?
         WHERE ${recovery ? recoveryGuardSql : "1"}
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
        ...(recovery ? [recovery.alertKey, recovery.environment, recovery.recoveryId] : []),
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

function readPollState(db: D1Database, source: NaverSourceKind) {
  return db
    .prepare(
      `SELECT committed_item_id, committed_published_at, scan_head_item_id,
              scan_head_published_at, next_offset, updated_at
       FROM source_poll_state WHERE source = ?`,
    )
    .bind(source)
    .first<PollStateRow>();
}

function boundaryHoldKey(boardId: 48 | 56, environment: OpsEnvironment) {
  return `naver-boundary:${environment}:${boardId}`;
}

function readBoundaryHold(db: D1Database, boardId: 48 | 56, environment: OpsEnvironment) {
  return db
    .prepare(
      `SELECT context_json FROM forecast_ops_alerts
       WHERE alert_key = ? AND environment = ? AND state = 'open'`,
    )
    .bind(boundaryHoldKey(boardId, environment), environment)
    .first<{ context_json: string }>();
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
  updated_at: string;
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
