import { ensureManualReviewStatement } from "./manual-review";
import { upsertOpsAlertStatement } from "./ops";
import type { ScheduleEvent } from "./types";

export async function legacyReviewStatements(db: D1Database, events: readonly ScheduleEvent[]) {
  const statements: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  const now = new Date().toISOString();
  const sources = events
    .filter((event) => event.manualReview && event.reason !== "runtime_notice_replaced")
    .map((event) => ({ source: event.sourceItem.source, itemId: event.sourceItem.itemId }));
  if (!sources.length) return statements;
  const existing = await db
    .prepare(`SELECT source,item_id FROM source_queue
    WHERE (source,item_id) IN (SELECT json_extract(value,'$.source'),json_extract(value,'$.itemId') FROM json_each(?))
    UNION SELECT source,item_id FROM source_manual_reviews
    WHERE (source,item_id) IN (SELECT json_extract(value,'$.source'),json_extract(value,'$.itemId') FROM json_each(?))`)
    .bind(JSON.stringify(sources), JSON.stringify(sources))
    .all<{ source: string; item_id: string }>();
  const present = new Set(existing.results.map((row) => `${row.source}:${row.item_id}`));
  for (const event of events) {
    if (!event.manualReview || event.reason === "runtime_notice_replaced") continue;
    const item = event.sourceItem;
    const key = `${item.source}:${item.itemId}`;
    if (seen.has(key) || present.has(key)) continue;
    seen.add(key);
    if (item.source === "x-nikke-kr" || !item.official || !validLegacyUrl(item.url)) {
      statements.push(
        upsertOpsAlertStatement(db, {
          alertKey: `legacy-review-unsupported:staging:${key}`,
          environment: "staging",
          severity: "warning",
          component: "source-queue",
          errorCode: "legacy_review_source_unsupported",
          context: {
            source: item.source,
            itemId: item.itemId,
            title: item.title,
            url: item.url,
            reason: event.reason,
            official: item.official,
          },
        }),
      );
      continue;
    }
    // Metadata-only admission: do not invent immutable full-body/revision
    // evidence. The existing review flow supports ignore/requeue/manual_event
    // from source_items without a typed full-body binding.
    statements.push(
      db
        .prepare(`INSERT OR IGNORE INTO source_queue
      (source,item_id,url,title,published_at,official,status,attempts,error_code,
       first_seen_at,updated_at)
      VALUES(?,?,?,?,?,1,'manual_review',0,?,?,?)`)
        .bind(
          item.source,
          item.itemId,
          item.url,
          item.title,
          item.publishedAt,
          event.reason ?? "legacy_manual_review",
          now,
          now,
        ),
    );
    statements.push(await ensureManualReviewStatement(db, item.source, item.itemId, now));
  }
  return statements;
}

function validLegacyUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "game.naver.com";
  } catch {
    return false;
  }
}
