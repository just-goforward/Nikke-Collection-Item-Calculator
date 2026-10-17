import { z } from "zod/mini";
import { assertForecastCandidateInvariants } from "../../shared/supplyForecastCandidate";
import { board11InvocationGate, board11MetadataEligible } from "./board11-policy";
import { rotationInvocationId } from "./collection-schedule";
import { sha256Hex, stableJson } from "./crypto";
import {
  candidateStatements,
  sourceItemAndEventStatements,
  unapprovedCandidateCondition,
} from "./db";
import { ensureManualReviewStatement } from "./manual-review";
import { type FetchLike, fetchNaverFeedMetadata, fetchNaverItemIdentity } from "./naver";
import {
  coveredBoundaryTail,
  naverPagePolicy,
  orderedOfficialBoundaryItems,
  samePublicationTime,
} from "./naver-boundary-proof";
import { isConstructedNoticeCandidate } from "./notice-processing";
import { type OpsEnvironment, upsertOpsAlertStatement } from "./ops";
import type { PollStateRow, SourceQueueRow } from "./source-queue-rows";
import {
  parseSourceQueueProcess,
  type SourceQueueProcessResult,
  validateSourceQueueResult,
} from "./source-queue-validation";
import type {
  CandidateBuildResult,
  CollectorEnv,
  NaverFeedMetadata,
  NaverSourceKind,
  NormalizedSourceItem,
  ScheduleEvent,
  SourceQueueItem,
} from "./types";

const PAGE_STEP = 1;
const sourceSchema = z.enum(["naver-board-11", "naver-board-48", "naver-board-56"]);
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
const nextCursorVersionSql = `CASE
  WHEN ? <= source_poll_state.updated_at
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', source_poll_state.updated_at, '+0.001 seconds')
  ELSE ?
END`;

type BoundaryHoldProof = {
  pageSize?: number;
  board: number;
  committedItemId: string | null;
  committedPublishedAt: string | null;
  scanHeadItemId: string | null;
  scanHeadPublishedAt: string | null;
};

export class NaverPartialSchemaError extends Error {
  readonly boardId: 11 | 48 | 56;
  readonly offset: number;
  readonly rejected: Awaited<ReturnType<typeof fetchNaverFeedMetadata>>["unknownRejected"];

  constructor(
    boardId: 11 | 48 | 56,
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
  invocationPrefix = "",
  rotationBoard?: 11 | 48 | 56 | null,
  board11Allowed = board11InvocationGate(db),
) {
  if (rotationBoard === 11 && !(await board11Allowed())) return null;
  const scheduledAt = new Date(scheduledTime).toISOString();
  const invocationId =
    rotationBoard === null
      ? `rotation-ingestion:${scheduledTime}:v2`
      : rotationBoard
        ? rotationInvocationId(rotationBoard, scheduledTime)
        : `${invocationPrefix}${deploymentSha}:${scheduledTime}`;
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO collector_invocations (
         invocation_id, deployment_sha, scheduled_at, started_at, status, poll_mode
       ) VALUES (?, ?, ?, ?, 'running', ?)`,
    )
    .bind(invocationId, deploymentSha, scheduledAt, new Date().toISOString(), pollMode)
    .run();
  return result.meta.changes === 1 ? invocationId : null;
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

export async function invocationCircuitState(db: D1Database, nowMs: number, board?: 11 | 48 | 56) {
  const rows = await db
    .prepare(
      `SELECT status, next_retry_at, error_code FROM collector_invocations
       WHERE status IN ('failure', 'completed')
         AND invocation_id NOT LIKE 'rotation-ingestion:%'
         ${board ? `AND invocation_id LIKE 'rotation-board-${board}:%'` : ""}
         AND (error_code IS NULL OR error_code NOT IN (
           'naver_boundary_held_only', 'naver_stale_poll_only'
         ))
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
  boardId: 11 | 48 | 56,
  fetcher: FetchLike = fetch,
  environment: OpsEnvironment = "staging",
  counts?: { rowsPolled: number },
  configuredPageSize?: string,
  board11Allowed = board11InvocationGate(db),
) {
  if (boardId === 11 && !(await board11Allowed())) return null;
  const source = `naver-board-${boardId}` as NaverSourceKind;
  const state = await readPollState(db, source);
  if (await readBoundaryHold(db, boardId, environment)) {
    return recoverMovedNaverBoundary(
      db,
      boardId,
      state,
      environment,
      fetcher,
      counts,
      board11Allowed,
    );
  }
  const offset = Number(state?.next_offset ?? 0);
  const policy = naverPagePolicy(
    boardId,
    state && (offset !== 0 || state.scan_head_item_id !== null)
      ? String(state.page_size)
      : configuredPageSize,
  );
  // Legacy row-index offsets (8, 16, ... 104) are not page cursors.
  if (!Number.isInteger(offset) || offset < 0 || offset >= policy.scanPages) {
    throw new Error("source_cursor_recovery_required");
  }
  const metadataPage = await fetchNaverFeedMetadata(boardId, offset, fetcher, policy.pageSize);
  countPolledRows(counts, metadataPage.rawFeedCount);
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
    scanComplete || metadataPage.rawFeedCount < policy.pageSize || offset + 1 >= policy.scanPages;
  const boundaryMissing = !scanComplete && scanEnded;
  const nowIso = new Date().toISOString();
  const guard = {
    sql: state
      ? `EXISTS (
          SELECT 1 FROM source_poll_state
          WHERE source = ? AND committed_item_id IS ? AND committed_published_at IS ?
            AND scan_head_item_id IS ? AND scan_head_published_at IS ?
            AND next_offset = ? AND updated_at = ? AND page_size = ?
        )`
      : "NOT EXISTS (SELECT 1 FROM source_poll_state WHERE source = ?)",
    bindings: state
      ? [
          source,
          state.committed_item_id,
          state.committed_published_at,
          state.scan_head_item_id,
          state.scan_head_published_at,
          state.next_offset,
          state.updated_at,
          state.page_size,
        ]
      : [source],
  };
  guard.sql += ` AND NOT EXISTS (
    SELECT 1 FROM forecast_ops_alerts
    WHERE alert_key = ? AND environment = ? AND state = 'open'
  )`;
  guard.bindings.push(boundaryHoldKey(boardId, environment), environment);
  const statements = queueStatements(db, toQueue, nowIso, guard);
  const cursorStatementIndex = statements.length;
  statements.push(
    db
      .prepare(
        `INSERT INTO source_poll_state (
           source, committed_item_id, committed_published_at, scan_head_item_id,
           scan_head_published_at, next_offset, updated_at, page_size
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
         ON CONFLICT(source) DO UPDATE SET
           committed_item_id = excluded.committed_item_id,
           committed_published_at = excluded.committed_published_at,
           scan_head_item_id = excluded.scan_head_item_id,
           scan_head_published_at = excluded.scan_head_published_at,
           next_offset = excluded.next_offset,
           page_size = excluded.page_size,
           updated_at = ${nextCursorVersionSql}`,
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
        policy.pageSize,
        ...guard.bindings,
        nowIso,
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
        // Immediately follows the guarded cursor statement in the same transaction.
        guard: { sql: "changes() = 1", bindings: [] },
        context: {
          board: boardId,
          pageSize: policy.pageSize,
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
  const results = await db.batch(statements);
  if (results[cursorStatementIndex]?.meta.changes !== 1) return null;
  if (boundaryMissing) throw new NaverScanBoundaryError(cursorStatementIndex);
  return cursorStatementIndex;
}

export async function recoverNaverBoundary(
  db: D1Database,
  environment: OpsEnvironment,
  raw: unknown,
  fetcher: FetchLike = fetch,
  movedIdentity?: Awaited<ReturnType<typeof fetchNaverItemIdentity>>,
  counts?: { rowsPolled: number },
  board11Allowed = board11InvocationGate(db),
) {
  const request = boundaryRecoverySchema.parse(raw);
  if (request.environment !== environment) throw new Error("naver_boundary_environment_mismatch");
  const boardId =
    request.source === "naver-board-48" ? 48 : request.source === "naver-board-11" ? 11 : 56;
  if (boardId === 11 && !(await board11Allowed())) throw new Error("board11_schema_required");
  const state = await readPollState(db, request.source);
  const hold = await readBoundaryHold(db, boardId, environment);
  if (!state || !hold) throw new Error("naver_boundary_not_held");
  const proof = JSON.parse(hold.context_json) as BoundaryHoldProof;
  assertRecoveryMarker(state, proof, request.expectedCommittedItemId, boardId);
  if (!movedIdentity) assertRecoverySnapshotProof(state, proof);
  const items = await readBoundaryRecoveryPages(
    db,
    boardId,
    state,
    fetcher,
    Boolean(movedIdentity),
    counts,
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
               AND next_offset = ? AND updated_at = ? AND page_size = ?
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
        state.page_size,
      ),
    ...queueStatements(db, toQueue, nowIso, { sql: recoveryGuardSql, bindings: guardBindings }),
    db
      .prepare(
        `UPDATE source_poll_state
         SET committed_item_id = ?, committed_published_at = ?, scan_head_item_id = NULL,
             scan_head_published_at = NULL, next_offset = 0, updated_at = ${nextCursorVersionSql}
         WHERE source = ? AND ${recoveryGuardSql}`,
      )
      .bind(
        scanHead.itemId,
        scanHead.publishedAt,
        nowIso,
        nowIso,
        request.source,
        ...guardBindings,
      ),
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

function assertRecoveryMarker(
  state: PollStateRow,
  proof: BoundaryHoldProof,
  expectedCommittedItemId: string,
  boardId: number,
) {
  if ((proof.pageSize ?? 10) !== state.page_size) {
    throw new Error("naver_boundary_marker_conflict");
  }
  if (
    state.committed_item_id !== expectedCommittedItemId ||
    proof.committedItemId !== expectedCommittedItemId ||
    proof.board !== boardId
  ) {
    throw new Error("naver_boundary_marker_conflict");
  }
}

async function readBoundaryRecoveryPages(
  db: D1Database,
  boardId: 11 | 48 | 56,
  state: PollStateRow,
  fetcher: FetchLike,
  moved: boolean,
  counts?: { rowsPolled: number },
) {
  const source = `naver-board-${boardId}` as NaverSourceKind;
  const items: NaverFeedMetadata[] = [];
  const policy = naverPagePolicy(boardId, String(state.page_size));
  const pageLimit = recoveryPageLimit(moved, policy.pageSize);
  const deadline = AbortSignal.timeout(40_000);
  const boundedFetch: FetchLike = (input, init) =>
    fetcher(input, {
      ...init,
      signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]),
    });
  try {
    for (let offset = 0; offset < pageLimit; offset += PAGE_STEP) {
      const page = await fetchNaverFeedMetadata(boardId, offset, boundedFetch, policy.pageSize);
      countPolledRows(counts, page.rawFeedCount);
      if (page.unknownRejected.length > 0)
        throw new NaverPartialSchemaError(boardId, offset, page.unknownRejected);
      if (page.rawFeedCount > policy.pageSize) throw new NaverScanBoundaryError(0);
      items.push(...page.items);
      if (moved) {
        if (movedWindowComplete(page.rawFeedCount, policy.pageSize, offset)) return items;
        continue;
      }
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
          coveredBoundaryTail(
            page.items,
            page.rawFeedCount,
            marker.publishedAt,
            Boolean(knownTail),
            policy.pageSize,
          )
        ) {
          deadline.throwIfAborted();
          return items;
        }
      }
      if (page.rawFeedCount < policy.pageSize) break;
    }
  } catch (error) {
    if (deadline.aborted) throw new Error("naver_timeout");
    throw error;
  }
  throw new NaverScanBoundaryError(0);
}

function movedWindowComplete(rawCount: number, pageSize: number, offset: number) {
  return rawCount < pageSize || offset + 1 >= 10 / pageSize;
}

function recoveryPageLimit(moved: boolean, pageSize: number) {
  return (moved ? 10 : 40) / pageSize;
}

async function recoverMovedNaverBoundary(
  db: D1Database,
  boardId: 11 | 48 | 56,
  state: PollStateRow | null,
  environment: OpsEnvironment,
  fetcher: FetchLike,
  counts?: { rowsPolled: number },
  board11Allowed = board11InvocationGate(db),
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
      counts,
      board11Allowed,
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

function countPolledRows(counts: { rowsPolled: number } | undefined, rows: number) {
  if (counts) counts.rowsPolled += rows;
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
  boardId: 11 | 48 | 56,
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

export async function processSourceQueue(
  db: D1Database,
  raw: unknown,
  transaction: {
    before?: D1PreparedStatement[];
    after?: D1PreparedStatement[];
  } = {},
  board11Allowed = board11InvocationGate(db),
) {
  const request = parseSourceQueueProcess(raw);
  if (
    request.results.some((result) => result.source === "naver-board-11") &&
    !(await board11Allowed())
  )
    throw new Error("board11_schema_required");
  const nowIso = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const result of request.results) {
    await validateSourceQueueResult(result);
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
          result.events ?? (result.event ? [result.event as ScheduleEvent] : []),
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
    const constructed = isConstructedNoticeCandidate(request.candidate);
    if (!constructed) {
      assertForecastCandidateInvariants(envelope.candidate);
    }
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
    // The local constructor hashes these exact bytes before deep-freezing the
    // envelope. Serialized admission never carries its object-identity proof.
    if (
      !constructed &&
      (await sha256Hex(stableJson(envelope.candidate))) !== envelope.payloadHash
    ) {
      throw new Error("candidate_payload_hash");
    }
    const eventKnown =
      request.results.some(
        (entry) =>
          entry.event?.eventId === eventId ||
          entry.events?.some((event) => event.eventId === eventId),
      ) ||
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
    );
    const unapproved = await unapprovedCandidateCondition(db);
    statements.push(
      db
        .prepare(
          `UPDATE forecast_candidates SET state = 'superseded', updated_at = ?
           WHERE schedule_event_id = ? AND game_day = ? AND candidate_id <> ?
             AND state IN ('crosschecked', 'x_unavailable', 'conflict', 'proposed')
             AND (${unapproved})`,
        )
        .bind(nowIso, eventId, gameDay, envelope.candidate.candidateId),
    );
  }
  statements.unshift(...(transaction.before ?? []));
  statements.push(...(transaction.after ?? []));
  if (statements.length > 0) await db.batch(statements);
  return { processed: request.results.length, candidateCreated: Boolean(request.candidate) };
}

function queueStatements(
  db: D1Database,
  items: readonly NaverFeedMetadata[],
  nowIso: string,
  guard?: { sql: string; bindings: (string | number | null)[] },
) {
  const eligible = items.filter(
    (item) =>
      item.source !== "naver-board-11" || board11MetadataEligible(item.title, item.official),
  );
  return eligible.map((item) =>
    db
      .prepare(
        `INSERT INTO source_queue (
           source, item_id, url, title, published_at, official, status,
           attempts, first_seen_at, updated_at
         ) SELECT ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?
         WHERE ${guard?.sql ?? "1"}
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
        ...(guard?.bindings ?? []),
      ),
  );
}

function queueResultStatement(db: D1Database, result: SourceQueueProcessResult, nowIso: string) {
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
              scan_head_published_at, next_offset, updated_at, page_size
       FROM source_poll_state WHERE source = ?`,
    )
    .bind(source)
    .first<PollStateRow>();
}

function boundaryHoldKey(boardId: 11 | 48 | 56, environment: OpsEnvironment) {
  return `naver-boundary:${environment}:${boardId}`;
}

function readBoundaryHold(db: D1Database, boardId: 11 | 48 | 56, environment: OpsEnvironment) {
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
