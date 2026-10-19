import type { NaverSourceKind, SourceQueueItem } from "./types";

type ReviewRow = {
  review_id: string;
  source: NaverSourceKind;
  item_id: string;
  generation: number;
  state: "pending" | "resolved" | "expired";
  decision: "requeue" | "ignore" | "manual_event" | null;
  actor: string | null;
  reason: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  url: string;
  title: string;
  published_at: string;
  error_code: string | null;
  queue_status: string;
};

type QueueRow = {
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

/** Historical source records are readable, never requeued or mutated here. */
export async function listSourceQueue(db: D1Database, limit: number) {
  const bounded = Math.max(1, Math.min(20, Math.trunc(limit)));
  const rows = await db
    .prepare(
      `SELECT source, item_id, url, title, published_at, official, status, attempts, error_code
       FROM source_queue WHERE status = 'pending'
       ORDER BY published_at ASC, item_id ASC LIMIT ?`,
    )
    .bind(bounded)
    .all<QueueRow>();
  return rows.results.map(
    (row): SourceQueueItem => ({
      source: row.source,
      itemId: row.item_id,
      url: row.url,
      title: row.title,
      publishedAt: row.published_at,
      official: row.official === 1,
      status: row.status,
      attempts: row.attempts,
      errorCode: row.error_code,
    }),
  );
}

export async function listManualReviews(
  db: D1Database,
  options: { status: "pending" | "resolved" | "expired"; limit: number },
) {
  const now = new Date().toISOString();
  const limit = Math.max(1, Math.min(20, Math.trunc(options.limit)));
  const rows = await db
    .prepare(
      `SELECT r.*, q.url, q.title, q.published_at, q.error_code,
                 q.status AS queue_status
          FROM source_manual_reviews r
          JOIN source_queue q ON q.source = r.source AND q.item_id = r.item_id WHERE
       CASE WHEN r.state = 'pending' AND r.expires_at <= ? THEN 'expired' ELSE r.state END = ?
       ORDER BY r.created_at, r.review_id LIMIT ?`,
    )
    .bind(now, options.status, limit)
    .all<ReviewRow>();
  return rows.results.map((row) => ({
    reviewId: row.review_id,
    source: row.source,
    itemId: row.item_id,
    generation: Number(row.generation),
    state: row.state === "pending" && row.expires_at <= now ? "expired" : row.state,
    decision: row.decision,
    actor: row.actor,
    reason: row.reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    sourceItem: {
      url: validatedNaverUrl(row.url),
      title: row.title,
      publishedAt: row.published_at,
      errorCode: row.error_code,
      queueStatus: row.queue_status,
    },
  }));
}

function validatedNaverUrl(value: string) {
  const url = URL.parse(value);
  if (url?.protocol !== "https:" || url.hostname !== "game.naver.com") {
    throw new Error("manual_review_source_url_invalid");
  }
  return url.toString();
}
