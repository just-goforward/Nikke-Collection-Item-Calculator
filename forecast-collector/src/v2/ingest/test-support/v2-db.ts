import type { Stream } from "../schedule";

// Direct reads/writes of the 0030 ledger so expectations do not go through
// the store under test.
export type StateRow = {
  committed_created_at: string | null;
  committed_feed_ids_json: string;
  continuation_cursor: number;
  consecutive_holds: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  edit_scan_completed_at: string | null;
};
export type RunRow = {
  run_id: string;
  generation: number;
  kind: string;
  status: string;
  pages_used: number;
  continuation_cursor: number;
  error_code: string | null;
};
export type AttemptRow = {
  kind: string;
  feed_id: string | null;
  game_day: string;
  outcome: string;
  error_code: string | null;
  next_attempt_at: string | null;
};

export async function state(db: D1Database, stream: Stream) {
  const row = await db
    .prepare("SELECT * FROM forecast_v2_monitor_state WHERE stream_id=?")
    .bind(stream)
    .first<StateRow>();
  if (!row) throw new Error(`state_missing:${stream}`);
  return row;
}
export async function boundary(db: D1Database, stream: Stream) {
  const row = await state(db, stream);
  return {
    createdAt: row.committed_created_at,
    feedIds: JSON.parse(row.committed_feed_ids_json) as string[],
  };
}
export async function runs(db: D1Database, stream: Stream) {
  return (
    await db
      .prepare(`SELECT run_id,generation,kind,status,pages_used,continuation_cursor,error_code
    FROM forecast_v2_monitor_runs WHERE stream_id=? ORDER BY generation`)
      .bind(stream)
      .all<RunRow>()
  ).results;
}
export async function attempts(db: D1Database) {
  return (
    await db
      .prepare(`SELECT kind,feed_id,game_day,outcome,error_code,next_attempt_at
    FROM forecast_v2_fetch_attempts ORDER BY attempted_at,rowid`)
      .all<AttemptRow>()
  ).results;
}
export async function hits(db: D1Database, runId?: string) {
  const sql = `SELECT feed_id FROM forecast_v2_search_hits ${runId ? "WHERE run_id=?" : ""} ORDER BY created_at DESC,feed_id`;
  const statement = runId ? db.prepare(sql).bind(runId) : db.prepare(sql);
  return (await statement.all<{ feed_id: string }>()).results.map((row) => row.feed_id);
}
export async function versions(db: D1Database) {
  return (
    await db
      .prepare(`SELECT version_id,feed_id,updated_date,body_text FROM forecast_v2_post_versions
    ORDER BY rowid`)
      .all<{ version_id: string; feed_id: string; updated_date: string; body_text: string }>()
  ).results;
}
export async function budget(db: D1Database, gameDay: string) {
  return db
    .prepare("SELECT metadata_used,detail_used FROM forecast_v2_request_budgets WHERE game_day=?")
    .bind(gameDay)
    .first<{ metadata_used: number; detail_used: number }>();
}
/** Rows of the existing ops alert path (`forecast_ops_alerts`, migration 0007). */
export async function alerts(db: D1Database) {
  return (
    await db
      .prepare(`SELECT environment,component,error_code,state,context_json
    FROM forecast_ops_alerts ORDER BY error_code`)
      .all<{
        environment: string;
        component: string;
        error_code: string;
        state: string;
        context_json: string;
      }>()
  ).results.map(({ context_json, ...row }) => ({ ...row, context: JSON.parse(context_json) }));
}
/** A queue row's next_attempt_at as epoch ms (null when unset); throws if the row is missing. */
export async function rulesRetryAt(db: D1Database, versionId: string, stream = "A") {
  const row = await db
    .prepare(
      "SELECT next_attempt_at FROM forecast_v2_rules_queue WHERE version_id=? AND stream_id=?",
    )
    .bind(versionId, stream)
    .first<{ next_attempt_at: string | null }>();
  if (!row) throw new Error(`rules_queue_row_missing:${versionId}:${stream}`);
  return row.next_attempt_at === null ? null : Date.parse(row.next_attempt_at);
}
/** Every forecast_v2_rules_queue row (0030), oldest version first. */
export async function rulesQueue(db: D1Database) {
  return (
    await db
      .prepare(`SELECT version_id,stream_id,status,attempts FROM forecast_v2_rules_queue
    ORDER BY created_at,version_id,stream_id`)
      .all<{ version_id: string; stream_id: string; status: string; attempts: number }>()
  ).results;
}
export async function count(db: D1Database, table: string) {
  if (!/^forecast_v2_[a-z_]+$|^collector_invocations$/.test(table)) throw new Error("table");
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
}

export async function seedBoundary(
  db: D1Database,
  stream: Stream,
  createdAt: string,
  feedIds: string[],
) {
  await db
    .prepare(`UPDATE forecast_v2_monitor_state SET committed_created_at=?,committed_feed_ids_json=?
    WHERE stream_id=?`)
    .bind(createdAt, JSON.stringify(feedIds), stream)
    .run();
}
export async function seedLease(db: D1Database, stream: Stream, owner: string, expiresAt: string) {
  await db
    .prepare(
      "UPDATE forecast_v2_monitor_state SET lease_owner=?,lease_expires_at=? WHERE stream_id=?",
    )
    .bind(owner, expiresAt, stream)
    .run();
}
export async function seedBudget(
  db: D1Database,
  gameDay: string,
  used: { metadata?: number; detail?: number },
) {
  await db
    .prepare(
      `INSERT INTO forecast_v2_request_budgets(game_day,metadata_used,detail_used) VALUES(?,?,?)`,
    )
    .bind(gameDay, used.metadata ?? 0, used.detail ?? 0)
    .run();
}
/** A previously stored body for (feed, updatedAt), so it is not pending. */
export async function seedVersion(
  db: D1Database,
  feedId: string,
  createdAt: string,
  updatedAt: string,
  board = 11,
) {
  await db
    .prepare(`INSERT INTO forecast_v2_post_versions
    (version_id,feed_id,updated_date,content_hash,board_id,created_at,fetched_at,body_text)
    VALUES(?,?,?,?,?,?,?,'seeded')`)
    .bind(
      `seed:${feedId}:${updatedAt}`,
      feedId,
      updatedAt,
      "0".repeat(64),
      board,
      createdAt,
      createdAt,
    )
    .run();
}
/** Mark every other non-E stream as recently edit-scanned so `stream` is the next edit scan. */
export async function preferEditScan(db: D1Database, stream: Stream, at: string) {
  await db
    .prepare(
      `UPDATE forecast_v2_monitor_state SET edit_scan_completed_at=CASE WHEN stream_id=? THEN NULL ELSE ? END`,
    )
    .bind(stream, at)
    .run();
}
