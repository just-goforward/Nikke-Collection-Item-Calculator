import { sha256Hex, stableJson } from "./crypto";
import { ensureManualReviewStatement } from "./manual-review";
import type {
  NaverSourceKind,
  NormalizedSourceItem,
  ScheduleEvent,
  SourceQueueItem,
  SourceQueueResult,
} from "./types";

export const INGESTION_BATCH_LIMIT = 2;
const LEASE_MS = 120_000;

export type IngestionQueueRow = {
  source: NaverSourceKind;
  item_id: string;
  url: string;
  title: string;
  published_at: string;
  official: number;
  status: SourceQueueItem["status"];
  attempts: number;
  review_generation: number;
  failures: number;
};

export type IngestionEntry = {
  row: IngestionQueueRow;
  result: SourceQueueResult;
  requestId: string | null;
};

export async function startIngestion(db: D1Database) {
  const now = new Date().toISOString();
  const token = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(`UPDATE runtime_ingestion_runs SET status='expired', finished_at=?, error_code='lease_expired'
      WHERE status='running' AND lease_until<=?`)
      .bind(now, now),
    db
      .prepare(`INSERT INTO runtime_ingestion_runs(token,status,started_at,lease_until)
      SELECT ?, 'running', ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM runtime_ingestion_runs WHERE status='running'
      ) AND NOT EXISTS (
        SELECT 1 FROM source_processor_state WHERE active_token IS NOT NULL
          OR state IN ('held','verifying')
      ) AND (SELECT COUNT(*) FROM (
        SELECT status FROM runtime_ingestion_runs WHERE started_at>=? ORDER BY started_at DESC LIMIT 3
      ) WHERE status IN ('failed','expired'))<3`)
      .bind(
        token,
        now,
        new Date(Date.now() + LEASE_MS).toISOString(),
        `${now.slice(0, 10)}T00:00:00.000Z`,
      ),
  ]);
  return results[1]?.meta.changes === 1 ? token : null;
}

export async function ingestionQueue(db: D1Database) {
  const rows = await db
    .prepare(`SELECT q.source,q.item_id,q.url,q.title,q.published_at,q.official,
      q.status,q.attempts,q.review_generation,COALESCE(i.failures,0) AS failures
    FROM source_queue q LEFT JOIN runtime_ingestion_items i ON i.source=q.source AND i.item_id=q.item_id
    WHERE q.status IN ('pending','processed','ignored')
      AND (i.next_check_at IS NULL OR i.next_check_at<=?)
    ORDER BY CASE WHEN q.status='pending' THEN 0 ELSE 1 END,
      COALESCE(i.checked_at,''),q.published_at DESC,q.source,q.item_id
    LIMIT ?`)
    .bind(new Date().toISOString(), INGESTION_BATCH_LIMIT)
    .all<IngestionQueueRow>();
  return rows.results;
}

export function queueItem(row: IngestionQueueRow): SourceQueueItem {
  return {
    source: row.source,
    itemId: row.item_id,
    url: row.url,
    title: row.title,
    publishedAt: row.published_at,
    official: row.official === 1,
    status: row.status,
    attempts: row.attempts,
    errorCode: null,
  };
}

export async function reserveNotice(
  db: D1Database,
  token: string,
  row: IngestionQueueRow,
  limit: number,
) {
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const requestId = crypto.randomUUID();
  const reserved = await db
    .prepare(`INSERT INTO runtime_notice_requests
    (request_id,run_token,utc_day,source,item_id,reserved_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS (
      SELECT 1 FROM runtime_ingestion_runs WHERE token=? AND status='running' AND lease_until>?
    ) AND (SELECT COUNT(*) FROM runtime_notice_requests WHERE utc_day=?)<?
      AND (SELECT COUNT(*) FROM runtime_notice_requests WHERE run_token=?)<?`)
    .bind(
      requestId,
      token,
      day,
      row.source,
      row.item_id,
      now,
      token,
      now,
      day,
      limit,
      token,
      INGESTION_BATCH_LIMIT,
    )
    .run();
  return reserved.meta.changes === 1 ? requestId : null;
}

export async function loadRuntimeEvents(db: D1Database, fallback: ScheduleEvent[]) {
  // The legacy loader only has an excerpt. Restore full immutable notice text
  // for runtime evidence, without changing historical/production semantics.
  const rows = await db
    .prepare(`SELECT b.event_id,r.item_json
    FROM schedule_event_source_revisions b JOIN source_notice_revisions r
      ON r.source=b.source AND r.item_id=b.item_id AND r.source_revision=b.source_revision
    JOIN schedule_events e ON e.event_id=b.event_id
    ORDER BY COALESCE(e.starts_at,e.observed_at) DESC LIMIT 240`)
    .all<{ event_id: string; item_json: string }>();
  const items = new Map(
    rows.results.map((row) => [
      row.event_id,
      JSON.parse(row.item_json) as ScheduleEvent["sourceItem"],
    ]),
  );
  return fallback.map((event) => ({
    ...event,
    sourceItem: items.get(event.eventId) ?? event.sourceItem,
  }));
}

export async function ingestionSettlement(
  db: D1Database,
  token: string,
  entries: IngestionEntry[],
  candidateId: string | null,
) {
  const now = new Date().toISOString();
  const before = [
    db
      .prepare(`INSERT INTO runtime_ingestion_commits(run_token,committed_at,queue_snapshot)
    VALUES(?,?,?)`)
      .bind(token, now, JSON.stringify(entries.map((entry) => entry.row))),
  ];
  const after: D1PreparedStatement[] = [];
  for (const { row, result, requestId } of entries) {
    const failures = result.outcome === "retry" ? Math.min(3, row.failures + 1) : 0;
    const outcome = failures === 3 ? "manual_review" : result.outcome;
    after.push(
      db
        .prepare(`UPDATE source_queue SET status=?,attempts=attempts+1,error_code=?,updated_at=?,
      review_generation=review_generation+CASE WHEN ?='manual_review' AND status<>'manual_review' THEN 1 ELSE 0 END
      WHERE source=? AND item_id=?`)
        .bind(
          outcome === "retry" ? "pending" : outcome,
          result.errorCode ?? null,
          now,
          outcome,
          row.source,
          row.item_id,
        ),
    );
    after.push(
      db
        .prepare(`INSERT INTO runtime_ingestion_items(source,item_id,checked_at,next_check_at,failures)
      VALUES(?,?,?,?,?) ON CONFLICT(source,item_id) DO UPDATE SET
        checked_at=excluded.checked_at,next_check_at=excluded.next_check_at,failures=excluded.failures`)
        .bind(
          row.source,
          row.item_id,
          now,
          new Date(
            Date.now() + (result.outcome === "retry" ? failures * 180_000 : 86_400_000),
          ).toISOString(),
          failures,
        ),
    );
    if (requestId) {
      after.push(
        db
          .prepare(`UPDATE runtime_notice_requests SET outcome=?,error_code=?,content_hash=?
        WHERE request_id=? AND outcome='reserved'`)
          .bind(outcome, result.errorCode ?? null, result.item?.contentHash ?? null, requestId),
      );
    }
    if (outcome === "manual_review") {
      after.push(await ensureManualReviewStatement(db, row.source, row.item_id, now));
    }
    if (result.item) {
      after.push(...(await noticeRevisionStatements(db, row, result.item, result.event, now)));
    }
    // Keep historical FK targets, but do not reuse an obsolete classification.
    if (result.outcome !== "retry") {
      after.push(
        db
          .prepare(`UPDATE schedule_events SET manual_review=1,reason='runtime_notice_replaced'
        WHERE source=? AND source_item_id=? AND event_id<>?`)
          .bind(row.source, row.item_id, result.event?.eventId ?? ""),
      );
    }
  }
  after.push(
    db
      .prepare(`UPDATE runtime_ingestion_runs SET status='completed',finished_at=?,candidate_id=?
    WHERE token=? AND status='running'`)
      .bind(now, candidateId, token),
  );
  return { before, after };
}

async function noticeRevisionStatements(
  db: D1Database,
  row: IngestionQueueRow,
  item: NormalizedSourceItem,
  event: ScheduleEvent | undefined,
  now: string,
) {
  const events = event ? [event] : [];
  const revisionHash = await sha256Hex(stableJson({ item, events }));
  const semanticHash = await sha256Hex(
    stableJson(events.map(({ sourceItem: _, ...event }) => event)),
  );
  const statements = [
    db
      .prepare(`INSERT INTO source_notice_revisions
        (source,item_id,source_revision,body_hash,revision_hash,semantic_hash,item_json,events_json,observed_at)
        SELECT ?,?,COALESCE(MAX(source_revision),0)+1,?,?,?,?,?,? FROM source_notice_revisions
        WHERE source=? AND item_id=? HAVING NOT EXISTS (
          SELECT 1 FROM source_notice_revisions WHERE source=? AND item_id=? AND revision_hash=?
          AND source_revision=(SELECT MAX(source_revision) FROM source_notice_revisions WHERE source=? AND item_id=?)
        )`)
      .bind(
        row.source,
        row.item_id,
        item.contentHash,
        revisionHash,
        semanticHash,
        stableJson(item),
        stableJson(events),
        now,
        row.source,
        row.item_id,
        row.source,
        row.item_id,
        revisionHash,
        row.source,
        row.item_id,
      ),
  ];
  if (event) {
    statements.push(
      db
        .prepare(`INSERT INTO schedule_event_source_revisions(event_id,source,item_id,source_revision)
          SELECT ?,?,?,MAX(source_revision) FROM source_notice_revisions WHERE source=? AND item_id=?
          ON CONFLICT(event_id) DO UPDATE SET source_revision=excluded.source_revision`)
        .bind(event.eventId, row.source, row.item_id, row.source, row.item_id),
    );
  }
  return statements;
}
