import type { ScheduleEvent } from "./types";

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
