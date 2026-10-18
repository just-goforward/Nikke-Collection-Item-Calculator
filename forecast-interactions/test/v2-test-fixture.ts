import legacySchema from "../../forecast-collector/fixtures/schema-v10.sql?raw";

// Same v1 reconstruction as scripts/forecast-migration-test-fixtures.ts.
// There is no 0001 SQL file: the original core tables are retained in schema-v10.
const tables = [
  "source_items",
  "schedule_events",
  "forecast_candidates",
  "candidate_sources",
  "source_watermarks",
];
export const v2Baseline =
  `CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
INSERT INTO schema_migrations VALUES(1,CURRENT_TIMESTAMP);
CREATE TABLE collector_runs(id INTEGER PRIMARY KEY);` +
  tables
    .map((table) => {
      const definition = legacySchema.match(
        new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\r?\\n\\);`),
      )?.[0];
      if (!definition) throw new Error(`missing_v1_table:${table}`);
      return definition;
    })
    .join("\n");
const migrations = import.meta.glob<string>("../../forecast-collector/migrations/00*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
export const v2Migrations = Object.entries(migrations)
  .sort()
  .filter(([path]) => {
    const version = Number(/\/(\d+)_/.exec(path)?.[1]);
    return version >= 2 && version <= 33;
  })
  .map(([, sql]) => sql);

export async function seedV2Decision(
  db: D1Database,
  channel: string,
  type = "solo_review",
  decisionId = "d",
  eventId: string | null = null,
  revision = 0,
  complete: boolean | undefined = true,
) {
  await db
    .prepare(`INSERT INTO forecast_v2_post_versions
    (version_id,feed_id,updated_date,content_hash,board_id,created_at,fetched_at,body_text)
    VALUES('fixture-source','1','2026-01-01',?,11,'2026-01-01','2026-01-01','original')
    ON CONFLICT DO NOTHING`)
    .bind("a".repeat(64))
    .run();
  const payload = JSON.stringify({
    env: "staging",
    eventId,
    sourceHash: "a".repeat(64),
    sourceVersion: "fixture-source",
    feedIds: [1],
    title: "공지",
    url: "https://game.naver.com/",
    options: [{ id: "a", label: "선택" }],
    extracted: {
      complete,
      startAt: "2026-11-01T12:00:00+09:00",
      endAt: "2026-11-02T05:00:00+09:00",
    },
  });
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  await db
    .prepare(`INSERT INTO forecast_v2_decision_requests
    (decision_id,type,event_id,payload_json,payload_hash,expected_calendar_revision,expires_at,status,created_at)
    VALUES(?,?,?,?,?,?,'2099-01-01T00:00:00Z','pending','2026-01-01T00:00:00Z')`)
    .bind(decisionId, type, eventId, payload, hash, revision)
    .run();
  await db
    .prepare(`INSERT INTO forecast_v2_notification_outbox
    (outbox_id,idempotency_key,kind,decision_id,channel_role,payload_json,payload_hash,state,next_attempt_at,message_id,channel_id,created_at,updated_at)
    VALUES(?,?,'decision_request',?,'approval','{}',?,'sent',0,'666666666',?,'now','now')`)
    .bind(decisionId, decisionId, decisionId, "a".repeat(64), channel)
    .run();
}
