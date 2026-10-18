import { freezeJson } from "../../shared/certifiedSupplyModel";
import type { ScheduleEvent } from "./types";

const revisionIdentity = new WeakMap<object, string>();
export function runtimeSourceIdentity(item: ScheduleEvent["sourceItem"]) {
  return revisionIdentity.get(item);
}

export async function loadRuntimeEvents(db: D1Database, fallback: ScheduleEvent[]) {
  // The legacy loader only has an excerpt. Restore full immutable notice text
  // for runtime evidence, without changing historical/production semantics.
  const rows = await db
    .prepare(`WITH selected AS MATERIALIZED (
    SELECT b.event_id,b.source,b.item_id,b.source_revision
    FROM schedule_event_source_revisions b JOIN source_notice_revisions r
      ON r.source=b.source AND r.item_id=b.item_id AND r.source_revision=b.source_revision
    JOIN schedule_events e ON e.event_id=b.event_id
    ORDER BY COALESCE(e.starts_at,e.observed_at) DESC LIMIT 240
    )
    SELECT s.event_id,s.source,s.item_id,s.source_revision,r.item_json
    FROM selected s JOIN source_notice_revisions r
      ON r.source=s.source AND r.item_id=s.item_id AND r.source_revision=s.source_revision`)
    .all<{
      event_id: string;
      source: string;
      item_id: string;
      source_revision: number;
      item_json: string;
    }>();
  const items = new Map(
    rows.results.map((row) => {
      const item = freezeJson(JSON.parse(row.item_json) as ScheduleEvent["sourceItem"]);
      // The referenced revision rows cannot be updated, deleted or replaced.
      // Only these frozen, database-loaded items receive the identity proof.
      revisionIdentity.set(item, JSON.stringify([row.source, row.item_id, row.source_revision]));
      return [row.event_id, item] as const;
    }),
  );
  return fallback.map((event) => ({
    ...event,
    sourceItem: items.get(event.eventId) ?? event.sourceItem,
  }));
}
