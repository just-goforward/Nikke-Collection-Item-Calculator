export async function seedNormalUsageGuard(db: D1Database | undefined, nowMs = Date.now()) {
  if (!db) throw new Error("test_usage_guard_binding_missing");
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS usage_guard_state (
         singleton_id INTEGER PRIMARY KEY,
         action TEXT NOT NULL,
         observed_at TEXT NOT NULL,
         period_start TEXT NOT NULL,
         period_end TEXT NOT NULL,
         evidence_hash TEXT NOT NULL
       )`,
    )
    .run();
  await db
    .prepare(
      `INSERT OR REPLACE INTO usage_guard_state (
         singleton_id, action, observed_at, period_start, period_end, evidence_hash
       ) VALUES (1, 'normal', ?, ?, ?, ?)`,
    )
    .bind(
      new Date(nowMs).toISOString(),
      new Date(nowMs - 24 * 60 * 60 * 1_000).toISOString(),
      new Date(nowMs + 31 * 24 * 60 * 60 * 1_000).toISOString(),
      "a".repeat(64),
    )
    .run();
}
