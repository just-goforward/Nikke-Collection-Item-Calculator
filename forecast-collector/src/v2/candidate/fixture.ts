export const now = Date.parse("2026-10-18T12:00:00+09:00");
export async function seed(db: D1Database) {
  for (const [round, start, end] of [
    [41, "2026-09-24T12:00:00+09:00", "2026-10-01T04:59:59+09:00"],
    [42, "2026-10-15T12:00:00+09:00", "2026-10-22T04:59:59+09:00"],
  ] as const) {
    await db
      .prepare(`INSERT INTO forecast_v2_post_versions VALUES(?,?,?,?,48,?,?,?)`)
      .bind(String(round), String(round), start, "a".repeat(64), start, start, `Season ${round}`)
      .run();
    await db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,prediction_provenance_json,source_feed_ids_json,created_at)
      VALUES(?,1,'solo','confirmed',?,?,?,?,?)`)
      .bind(`solo${round}`, start, end, JSON.stringify({ round }), JSON.stringify([round]), start)
      .run();
    await db
      .prepare("INSERT INTO forecast_v2_calendar_heads VALUES(?,1)")
      .bind(`solo${round}`)
      .run();
  }
  await db
    .prepare(`INSERT INTO forecast_v2_grant_revisions VALUES('test',1,'2026-10-18',10,5,NULL,?)`)
    .bind(new Date(now).toISOString())
    .run();
  await db.prepare("INSERT INTO forecast_v2_grant_heads VALUES('test',1,'2026-10-18',10,5)").run();
}
