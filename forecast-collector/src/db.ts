import type { SupplyForecastCandidateEnvelope } from "../../shared/supplyForecastCandidate";
import {
  assertForecastCandidateInvariants,
  supplyForecastCandidateSchema,
} from "../../shared/supplyForecastCandidate";
import { sha256Hex, stableJson } from "./crypto";
import type {
  CandidateBuildResult,
  CollectionSummary,
  NormalizedSourceItem,
  ScheduleEvent,
} from "./types";

export async function persistSourceItemsAndEvents(
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
  if (statements.length > 0) await db.batch(statements);
}

export async function loadScheduleEvents(db: D1Database): Promise<ScheduleEvent[]> {
  const result = await db
    .prepare(
      `SELECT e.event_id, e.event_type, e.starts_at, e.ends_at, e.schedule_status,
              e.manual_review, e.reason, s.source, s.item_id, s.url, s.title,
              s.excerpt, s.published_at, s.content_hash, s.structured, s.official
       FROM schedule_events e
       JOIN source_items s ON s.source = e.source AND s.item_id = e.source_item_id
       WHERE e.event_type IN ('solo', 'collaboration')
       ORDER BY COALESCE(e.starts_at, e.observed_at) DESC
       LIMIT 120`,
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

export async function candidateIdExists(db: D1Database, candidateId: string) {
  const row = await db
    .prepare("SELECT candidate_id FROM forecast_candidates WHERE candidate_id = ?")
    .bind(candidateId)
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
  const { candidate, payloadHash } = result;
  const now = new Date().toISOString();
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
  await db.batch(statements);
}

export async function listProposalCandidates(db: D1Database) {
  const result = await db
    .prepare(
      `SELECT candidate_id, payload_json, payload_hash
       FROM forecast_candidates
       WHERE state IN ('crosschecked', 'x_unavailable')
       ORDER BY created_at ASC
       LIMIT 20`,
    )
    .all<{ candidate_id: string; payload_json: string; payload_hash: string }>();
  return result.results.map(
    (row): SupplyForecastCandidateEnvelope => ({
      payloadHash: row.payload_hash,
      candidate: JSON.parse(row.payload_json) as SupplyForecastCandidateEnvelope["candidate"],
    }),
  );
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

export async function supersedeEarlierCandidates(
  db: D1Database,
  eventId: string,
  gameDay: string,
  currentCandidateId: string,
) {
  await db
    .prepare(
      `UPDATE forecast_candidates
       SET state = 'superseded', updated_at = ?
       WHERE schedule_event_id = ? AND game_day = ? AND candidate_id <> ?
         AND state IN ('crosschecked', 'x_unavailable', 'conflict', 'proposed')`,
    )
    .bind(new Date().toISOString(), eventId, gameDay, currentCandidateId)
    .run();
}

export async function recordCollectorRun(
  db: D1Database,
  source: "naver" | "x" | "collector",
  status: "completed" | "failure" | "circuit_open",
  startedAt: string,
  errorCode: string | null,
  nextRetryAt: string | null,
  itemCount: number,
) {
  await db
    .prepare(
      `INSERT INTO collector_runs (
         source, status, started_at, finished_at, error_code, next_retry_at, item_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(source, status, startedAt, new Date().toISOString(), errorCode, nextRetryAt, itemCount)
    .run();
}

export async function naverCircuitState(db: D1Database, nowMs: number) {
  const result = await db
    .prepare(
      `SELECT status, next_retry_at FROM collector_runs
       WHERE source = 'naver' ORDER BY started_at DESC LIMIT 12`,
    )
    .all<{ status: string; next_retry_at: string | null }>();
  let failures = 0;
  for (const row of result.results) {
    if (row.status !== "failure") break;
    failures += 1;
  }
  const latestRetry = result.results[0]?.next_retry_at;
  return {
    failures,
    open: failures >= 3 && typeof latestRetry === "string" && Date.parse(latestRetry) > nowMs,
    nextRetryAt: latestRetry ?? null,
  };
}

export async function shouldProbeX(db: D1Database, nowMs: number, immediate: boolean) {
  const dayStart = new Date(nowMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  const quota = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM collector_runs
       WHERE source = 'x' AND started_at >= ?`,
    )
    .bind(dayStart.toISOString())
    .first<{ count: number }>();
  if (Number(quota?.count ?? 0) >= 54) return false;
  if (immediate) return true;
  const latest = await db
    .prepare(
      "SELECT started_at FROM collector_runs WHERE source = 'x' ORDER BY started_at DESC LIMIT 1",
    )
    .first<{ started_at: string }>();
  return !latest || nowMs - Date.parse(latest.started_at) >= 30 * 60 * 1000;
}

export async function readHealth(db: D1Database) {
  const latest = await db
    .prepare(
      `SELECT source, status, finished_at FROM collector_runs
       WHERE id IN (SELECT MAX(id) FROM collector_runs GROUP BY source)`,
    )
    .all<{ source: string; status: string; finished_at: string }>();
  const counts = await db
    .prepare("SELECT state, COUNT(*) AS count FROM forecast_candidates GROUP BY state")
    .all<{ state: string; count: number }>();
  return {
    status: "ok",
    sources: Object.fromEntries(
      latest.results.map((row) => [
        row.source,
        { status: row.status, lastFinishedAt: row.finished_at },
      ]),
    ),
    candidateCounts: Object.fromEntries(counts.results.map((row) => [row.state, row.count])),
  };
}

export async function readCanaryReport(db: D1Database, nowMs: number, deploymentSha: string) {
  const since = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  const runs = await db
    .prepare(
      `SELECT source, status, started_at, finished_at
       FROM collector_runs WHERE started_at >= ? ORDER BY started_at ASC`,
    )
    .bind(since)
    .all<{ source: string; status: string; started_at: string; finished_at: string }>();
  const first = await db
    .prepare("SELECT started_at FROM collector_runs ORDER BY started_at ASC LIMIT 1")
    .first<{ started_at: string }>();
  const candidates = await db
    .prepare("SELECT payload_json, payload_hash FROM forecast_candidates")
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
  const naverRuns = runs.results.filter((row) => row.source === "naver");
  const xRuns = runs.results.filter((row) => row.source === "x");
  const naverCompleted = naverRuns.filter((row) => row.status === "completed").length;
  const xCompleted = xRuns.filter((row) => row.status === "completed").length;
  const naverSuccessRate = naverRuns.length === 0 ? 0 : naverCompleted / naverRuns.length;
  const xSuccessRate = xRuns.length === 0 ? 0 : xCompleted / xRuns.length;
  const eligible = first !== null && nowMs - Date.parse(first.started_at) >= 24 * 60 * 60 * 1000;
  const latestNaver = naverRuns.at(-1);
  const passed =
    eligible &&
    naverRuns.length >= 400 &&
    naverSuccessRate >= 0.99 &&
    latestNaver?.status === "completed" &&
    invalidCandidates === 0 &&
    invalidWatermarks === 0;
  return {
    deploymentSha,
    window: { since, until: new Date(nowMs).toISOString(), eligible },
    naver: {
      attempts: naverRuns.length,
      completed: naverCompleted,
      successRate: naverSuccessRate,
      latestStatus: latestNaver?.status ?? "missing",
    },
    x: {
      attempts: xRuns.length,
      completed: xCompleted,
      successRate: xSuccessRate,
      automationQualified: xRuns.length > 0 && xSuccessRate >= 0.9,
    },
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

export function emptyCollectionSummary(outcome: CollectionSummary["outcome"]): CollectionSummary {
  return { outcome, naverItems: 0, parsedEvents: 0, candidates: 0, xStatus: "not_run" };
}
