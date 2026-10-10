// Read-only advisory projection of checkpoint-18 forecastReviewHold semantics.
// Do not import its lifecycle/processor readers: they renew cards, initialize
// the singleton, and settle expired leases. Public health must do none of those.
const MANUAL_REVIEW_HOLD_STARTED_SQL = `COALESCE((SELECT MIN(r.created_at)
  FROM source_manual_reviews r WHERE r.source=q.source AND r.item_id=q.item_id
    AND r.state IN ('pending','expired') AND r.created_at>=COALESCE((SELECT MAX(d.resolved_at)
      FROM source_manual_reviews d WHERE d.source=q.source AND d.item_id=q.item_id AND d.state='resolved'),'')),q.updated_at)`;

const SOURCE_REVIEW_PENDING_SQL = `SELECT q.source,q.item_id,q.review_generation,q.error_code,
  COALESCE((SELECT MIN(x.created_at) FROM source_processor_item_exceptions x WHERE x.source=q.source AND x.item_id=q.item_id
    AND NOT EXISTS(SELECT 1 FROM source_processor_exception_resolutions xr WHERE xr.exception_id=x.exception_id)),
    (${MANUAL_REVIEW_HOLD_STARTED_SQL})) AS hold_started_at FROM source_queue q
  WHERE q.status='manual_review' AND (q.official=1 OR q.error_code IN ('source_body_revision_requires_review','source_queue_authority_unknown')
    OR EXISTS(SELECT 1 FROM schedule_events accepted WHERE accepted.source=q.source AND accepted.source_item_id=q.item_id AND accepted.event_type IN ('solo','collaboration') AND accepted.schedule_status='confirmed' AND accepted.manual_review=0)
    OR EXISTS(SELECT 1 FROM schedule_events e WHERE e.source=q.source AND e.source_item_id=q.item_id
      AND e.event_type IN ('solo','collaboration','schedule_change') AND e.manual_review=1 AND COALESCE(e.reason,'') NOT IN ('manual_review_ignored','manual_review_resolved')))
    OR EXISTS(SELECT 1 FROM source_processor_item_exceptions x WHERE x.source=q.source AND x.item_id=q.item_id
      AND NOT EXISTS(SELECT 1 FROM source_processor_exception_resolutions xr WHERE xr.exception_id=x.exception_id))`;

export async function readSourceReviewStatus(db: D1Database) {
  const processor = await db
    .prepare(
      "SELECT state,active_token,lease_until FROM source_processor_state WHERE singleton_id=1 LIMIT 1",
    )
    .first<{ state: string; active_token: string | null; lease_until: string | null }>();
  const rows = await db
    .prepare(`${SOURCE_REVIEW_PENDING_SQL} ORDER BY q.updated_at,q.source,q.item_id LIMIT 20`)
    .all<{
      source: string;
      item_id: string;
      review_generation: number;
      error_code: string | null;
    }>();
  // Never turn absent state or an expired-but-unsettled lease into "current".
  // Oversized identifiers remain a hold, but their public projection is bounded.
  const invalidMetadata = rows.results.some(
    (row) =>
      row.source.length === 0 ||
      row.source.length > 512 ||
      row.item_id.length === 0 ||
      row.item_id.length > 512 ||
      (row.error_code !== null && (row.error_code.length === 0 || row.error_code.length > 512)) ||
      !Number.isSafeInteger(row.review_generation) ||
      row.review_generation < 0,
  );
  return {
    state: rows.results.length ? ("review_pending" as const) : ("current" as const),
    processingBlocked:
      processor?.state !== "active" ||
      processor.active_token !== null ||
      processor.lease_until !== null ||
      invalidMetadata,
    changedSources: rows.results.map((row) => ({
      source: row.source.slice(0, 512),
      itemId: row.item_id.slice(0, 512),
      generation: Number(row.review_generation),
      errorCode: row.error_code?.slice(0, 512) ?? null,
    })),
  };
}
