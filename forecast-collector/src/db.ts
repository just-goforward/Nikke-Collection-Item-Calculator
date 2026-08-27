import type { SupplyForecastCandidateEnvelope } from "../../shared/supplyForecastCandidate";
import {
  assertForecastCandidateInvariants,
  SUPPLY_FORECAST_CANDIDATE_PAYLOAD_VERSION,
  supplyForecastCandidateSchema,
} from "../../shared/supplyForecastCandidate";
import { SUPPLY_RULES_VERSION } from "../../shared/supplyForecastModel";
import { sha256Hex, stableJson } from "./crypto";
import type { CandidateBuildResult, NormalizedSourceItem, ScheduleEvent } from "./types";

export async function persistSourceItemsAndEvents(
  db: D1Database,
  items: readonly NormalizedSourceItem[],
  events: readonly ScheduleEvent[],
  nowIso: string,
) {
  const statements = sourceItemAndEventStatements(db, items, events, nowIso);
  if (statements.length > 0) await db.batch(statements);
}

export function sourceItemAndEventStatements(
  db: D1Database,
  items: readonly NormalizedSourceItem[],
  events: readonly ScheduleEvent[],
  nowIso: string,
) {
  const statements: D1PreparedStatement[] = [];
  for (const item of items) {
    statements.push(
      db
        .prepare(
          `INSERT INTO source_items (
             source, item_id, url, title, excerpt, published_at, content_hash,
             structured, official, first_seen_at, last_seen_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source, item_id) DO UPDATE SET
             url = excluded.url,
             title = excluded.title,
             excerpt = excluded.excerpt,
             published_at = excluded.published_at,
             content_hash = excluded.content_hash,
             structured = excluded.structured,
             official = excluded.official,
             last_seen_at = excluded.last_seen_at`,
        )
        .bind(
          item.source,
          item.itemId,
          item.url,
          item.title,
          item.excerpt,
          item.publishedAt,
          item.contentHash,
          item.structured ? 1 : 0,
          item.official ? 1 : 0,
          nowIso,
          nowIso,
        ),
    );
  }
  for (const event of events) {
    statements.push(
      db
        .prepare(
          `INSERT INTO schedule_events (
             event_id, event_type, source, source_item_id, starts_at, ends_at,
             schedule_status, manual_review, reason, observed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id) DO UPDATE SET
             starts_at = excluded.starts_at,
             ends_at = excluded.ends_at,
             schedule_status = excluded.schedule_status,
             manual_review = excluded.manual_review,
             reason = excluded.reason`,
        )
        .bind(
          event.eventId,
          event.eventType,
          event.sourceItem.source,
          event.sourceItem.itemId,
          event.startsAt,
          event.endsAt,
          event.scheduleStatus,
          event.manualReview ? 1 : 0,
          event.reason,
          nowIso,
        ),
    );
  }
  const latestBySource = new Map<NormalizedSourceItem["source"], NormalizedSourceItem>();
  for (const item of items) {
    const current = latestBySource.get(item.source);
    if (
      !current ||
      Date.parse(item.publishedAt) > Date.parse(current.publishedAt) ||
      (item.publishedAt === current.publishedAt && item.itemId.localeCompare(current.itemId) > 0)
    ) {
      latestBySource.set(item.source, item);
    }
  }
  for (const item of latestBySource.values()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO source_watermarks (
             source, item_id, published_at, content_hash, updated_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(source) DO UPDATE SET
             item_id = excluded.item_id,
             published_at = excluded.published_at,
             content_hash = excluded.content_hash,
             updated_at = excluded.updated_at
           WHERE excluded.published_at > source_watermarks.published_at
              OR (excluded.published_at = source_watermarks.published_at
                  AND excluded.item_id > source_watermarks.item_id)`,
        )
        .bind(item.source, item.itemId, item.publishedAt, item.contentHash, nowIso),
    );
  }
  return statements;
}

export async function loadScheduleEvents(db: D1Database): Promise<ScheduleEvent[]> {
  const result = await db
    .prepare(
      `SELECT e.event_id, e.event_type, e.starts_at, e.ends_at, e.schedule_status,
              e.manual_review, e.reason, s.source, s.item_id, s.url, s.title,
              s.excerpt, s.published_at, s.content_hash, s.structured, s.official
       FROM schedule_events e
       JOIN source_items s ON s.source = e.source AND s.item_id = e.source_item_id
       ORDER BY COALESCE(e.starts_at, e.observed_at) DESC
       LIMIT 240`,
    )
    .all<ScheduleEventRow>();
  return result.results.map(rowToScheduleEvent);
}

export async function candidateExists(
  db: D1Database,
  eventId: string,
  gameDay: string,
  sourceStatus: string,
) {
  const row = await db
    .prepare(
      `SELECT candidate_id FROM forecast_candidates
       WHERE schedule_event_id = ? AND game_day = ? AND source_status = ?`,
    )
    .bind(eventId, gameDay, sourceStatus)
    .first<{ candidate_id: string }>();
  return row?.candidate_id ?? null;
}

export async function nextForecastRevision(db: D1Database, gameDay: string) {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(revision), 0) AS revision FROM forecast_candidates WHERE game_day = ?",
    )
    .bind(gameDay)
    .first<{ revision: number }>();
  return Number(row?.revision ?? 0) + 1;
}

export async function persistCandidate(
  db: D1Database,
  result: CandidateBuildResult,
  eventId: string,
  gameDay: string,
  revision: number,
) {
  await db.batch(candidateStatements(db, result, eventId, gameDay, revision));
}

export function candidateStatements(
  db: D1Database,
  result: CandidateBuildResult,
  eventId: string,
  gameDay: string,
  revision: number,
  now = new Date().toISOString(),
) {
  const { candidate, payloadHash } = result;
  const targetState = candidate.sourceStatus;
  const statements = [
    db
      .prepare(
        `INSERT INTO forecast_candidates (
           candidate_id, forecast_id, schedule_event_id, game_day, revision,
           source_status, state, payload_json, payload_hash, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'observed', ?, ?, ?, ?)
         ON CONFLICT(candidate_id) DO NOTHING`,
      )
      .bind(
        candidate.candidateId,
        candidate.forecastId,
        eventId,
        gameDay,
        revision,
        candidate.sourceStatus,
        JSON.stringify(candidate),
        payloadHash,
        now,
        now,
      ),
    db
      .prepare(
        "UPDATE forecast_candidates SET state = 'parsed', updated_at = ? WHERE candidate_id = ? AND state = 'observed'",
      )
      .bind(now, candidate.candidateId),
    db
      .prepare(
        "UPDATE forecast_candidates SET state = ?, updated_at = ? WHERE candidate_id = ? AND state = 'parsed'",
      )
      .bind(targetState, now, candidate.candidateId),
    ...candidate.sourceEvidence.map((source) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO candidate_sources (candidate_id, source, source_item_id)
           VALUES (?, ?, ?)`,
        )
        .bind(candidate.candidateId, source.source, source.itemId),
    ),
  ];
  return statements;
}

export async function listProposalCandidates(db: D1Database) {
  const result = await db
    .prepare(
      `SELECT candidate_id, payload_json, payload_hash
       FROM forecast_candidates
       WHERE state IN ('crosschecked', 'x_unavailable')
         AND json_extract(payload_json, '$.payloadVersion') = ?
         AND json_extract(payload_json, '$.rulesVersion') = ?
       ORDER BY created_at ASC
       LIMIT 20`,
    )
    .bind(SUPPLY_FORECAST_CANDIDATE_PAYLOAD_VERSION, SUPPLY_RULES_VERSION)
    .all<{ candidate_id: string; payload_json: string; payload_hash: string }>();
  return result.results.map(
    (row): SupplyForecastCandidateEnvelope => ({
      payloadHash: row.payload_hash,
      candidate: JSON.parse(row.payload_json) as SupplyForecastCandidateEnvelope["candidate"],
    }),
  );
}

export async function supersedeIncompatibleCandidates(db: D1Database) {
  const result = await db
    .prepare(
      `UPDATE forecast_candidates
       SET state = 'superseded', updated_at = ?
       WHERE state IN ('observed', 'parsed', 'crosschecked', 'x_unavailable', 'conflict', 'proposed')
         AND (
           COALESCE(json_extract(payload_json, '$.payloadVersion'), -1) <> ?
           OR COALESCE(json_extract(payload_json, '$.rulesVersion'), '') <> ?
         )`,
    )
    .bind(new Date().toISOString(), SUPPLY_FORECAST_CANDIDATE_PAYLOAD_VERSION, SUPPLY_RULES_VERSION)
    .run();
  return Number(result.meta.changes ?? 0);
}

export async function markCandidateProposed(db: D1Database, candidateId: string) {
  const result = await db
    .prepare(
      `UPDATE forecast_candidates
       SET state = 'proposed', updated_at = ?
       WHERE candidate_id = ? AND state IN ('crosschecked', 'x_unavailable')`,
    )
    .bind(new Date().toISOString(), candidateId)
    .run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function readHealth(db: D1Database) {
  const latest = await db
    .prepare(
      `SELECT status, COALESCE(finished_at, started_at) AS finished_at
       FROM collector_invocations ORDER BY scheduled_at DESC LIMIT 1`,
    )
    .first<{ status: string; finished_at: string }>();
  const counts = await db
    .prepare("SELECT state, COUNT(*) AS count FROM forecast_candidates GROUP BY state")
    .all<{ state: string; count: number }>();
  return {
    status: "ok",
    collector: latest
      ? { status: latest.status, lastFinishedAt: latest.finished_at }
      : { status: "missing", lastFinishedAt: null },
    candidateCounts: Object.fromEntries(counts.results.map((row) => [row.state, row.count])),
  };
}

export async function readCanaryReport(db: D1Database, nowMs: number, deploymentSha: string) {
  const windowHours = 12;
  const minimumScheduled = 200;
  const minimumCompletionRate = 0.99;
  const since = new Date(nowMs - windowHours * 60 * 60 * 1000).toISOString();
  const invocations = await db
    .prepare(
      `SELECT status, poll_mode, scheduled_at, started_at, finished_at
       FROM collector_invocations
       WHERE scheduled_at >= ? AND deployment_sha = ?
       ORDER BY scheduled_at ASC`,
    )
    .bind(since, deploymentSha)
    .all<{
      status: string;
      poll_mode: "both" | "alternating";
      scheduled_at: string;
      started_at: string;
      finished_at: string | null;
    }>();
  const first = await db
    .prepare(
      `SELECT scheduled_at AS started_at FROM collector_invocations
       WHERE deployment_sha = ? ORDER BY scheduled_at ASC LIMIT 1`,
    )
    .bind(deploymentSha)
    .first<{ started_at: string }>();
  const candidates = await db
    .prepare(
      `SELECT payload_json, payload_hash FROM forecast_candidates
       WHERE state NOT IN ('approved', 'rejected', 'superseded')`,
    )
    .all<{ payload_json: string; payload_hash: string }>();
  const watermarks = await db
    .prepare(
      `SELECT w.source, w.item_id, w.published_at, w.content_hash,
              i.item_id AS stored_item_id, i.published_at AS stored_published_at,
              i.content_hash AS stored_content_hash
       FROM source_watermarks w
       LEFT JOIN source_items i ON i.source = w.source AND i.item_id = w.item_id`,
    )
    .all<{
      source: string;
      item_id: string;
      published_at: string;
      content_hash: string;
      stored_item_id: string | null;
      stored_published_at: string | null;
      stored_content_hash: string | null;
    }>();
  const queue = await db
    .prepare(
      `SELECT status, attempts, source, item_id, url, published_at
       FROM source_queue`,
    )
    .all<{
      status: string;
      attempts: number;
      source: string;
      item_id: string;
      url: string;
      published_at: string;
    }>();
  const cursors = await db
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
    }>();
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
  const invalidWatermarks = watermarks.results.filter(
    (row) =>
      row.stored_item_id !== row.item_id ||
      row.stored_published_at !== row.published_at ||
      row.stored_content_hash !== row.content_hash,
  ).length;
  const effective = invocations.results.map((row) => ({
    ...row,
    status:
      row.status === "running" && nowMs - Date.parse(row.scheduled_at) >= 15 * 60 * 1000
        ? "abandoned"
        : row.status,
  }));
  const completed = effective.filter((row) => row.status === "completed").length;
  const failures = effective.filter((row) => row.status === "failure").length;
  const abandoned = effective.filter((row) => row.status === "abandoned").length;
  const successRate = effective.length === 0 ? 0 : completed / effective.length;
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
  const eligible =
    first !== null && nowMs - Date.parse(first.started_at) >= windowHours * 60 * 60 * 1000;
  const latest = effective.at(-1);
  const earlyFailure =
    first !== null &&
    nowMs - Date.parse(first.started_at) >= 2 * 60 * 60 * 1000 &&
    effective.length > 0 &&
    abandoned / effective.length > 0.01;
  const passed =
    eligible &&
    effective.length >= minimumScheduled &&
    successRate >= minimumCompletionRate &&
    latest?.status === "completed" &&
    abandoned === 0 &&
    invalidCandidates === 0 &&
    invalidWatermarks === 0 &&
    invalidQueue === 0 &&
    invalidCursors === 0;
  return {
    version: 3,
    deploymentSha,
    pollMode: latest?.poll_mode ?? "missing",
    acceptance: { windowHours, minimumScheduled, minimumCompletionRate },
    window: { since, until: new Date(nowMs).toISOString(), eligible, earlyFailure },
    invocations: {
      scheduled: effective.length,
      completed,
      failure: failures,
      abandoned,
      successRate,
      latestStatus: latest?.status ?? "missing",
    },
    queue: { count: queue.results.length, invalid: invalidQueue },
    cursors: { count: cursors.results.length, invalid: invalidCursors },
    candidates: { count: candidates.results.length, invalid: invalidCandidates },
    watermarks: { count: watermarks.results.length, invalid: invalidWatermarks },
    passed,
  };
}

export function nextNaverRetryAt(nowMs: number, consecutiveFailures: number) {
  const delayMinutes = Math.min(30, 3 * 2 ** Math.max(0, consecutiveFailures - 2));
  return new Date(nowMs + delayMinutes * 60 * 1000).toISOString();
}

type ScheduleEventRow = {
  event_id: string;
  event_type: ScheduleEvent["eventType"];
  starts_at: string | null;
  ends_at: string | null;
  schedule_status: "confirmed" | "estimated";
  manual_review: number;
  reason: string | null;
  source: NormalizedSourceItem["source"];
  item_id: string;
  url: string;
  title: string;
  excerpt: string;
  published_at: string;
  content_hash: string;
  structured: number;
  official: number;
};

function rowToScheduleEvent(row: ScheduleEventRow): ScheduleEvent {
  const sourceItem: NormalizedSourceItem = {
    source: row.source,
    itemId: row.item_id,
    url: row.url,
    title: row.title,
    excerpt: row.excerpt,
    normalizedText: `${row.title} ${row.excerpt}`,
    publishedAt: row.published_at,
    contentHash: row.content_hash,
    structured: row.structured === 1,
    official: row.official === 1,
  };
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    sourceItem,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    scheduleStatus: row.schedule_status,
    manualReview: row.manual_review === 1,
    reason: row.reason,
  };
}
