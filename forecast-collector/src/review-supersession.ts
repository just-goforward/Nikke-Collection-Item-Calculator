/** Only the latest generation can retire historical manual-review blockers. */
export async function ignoredReviewSources(db: D1Database) {
  const rows = await db
    .prepare(`SELECT m.source,m.item_id FROM source_manual_reviews m
    JOIN source_queue q ON q.source=m.source AND q.item_id=m.item_id
    WHERE m.state='resolved' AND (
      m.decision IN ('ignore','manual_event') OR
      (m.decision='requeue' AND q.status IN ('processed','ignored') AND q.review_generation>=m.generation)
    ) AND NOT EXISTS(
      SELECT 1 FROM source_manual_reviews newer WHERE newer.source=m.source
        AND newer.item_id=m.item_id AND newer.generation>m.generation
    )`)
    .all<{ source: string; item_id: string }>();
  return new Set(rows.results.map((row) => `${row.source}:${row.item_id}`));
}
