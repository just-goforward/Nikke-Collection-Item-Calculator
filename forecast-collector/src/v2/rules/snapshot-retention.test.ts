import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { executeTestSql } from "../../../../shared/testD1Sql";
import schema from "../../test-schema";
import { persistCalendar } from "./snapshot-store";

it("bounds retention at ten and preserves active, recent and unsent-referenced snapshots", async () => {
  await reset();
  const db = env.FORECAST_DB;
  await executeTestSql(db, schema, applyD1Migrations);
  const days = [{ gameDay: "2026-01-01", events: [], grants: [], ii: 0, box: 0 }];
  const active = await persistCalendar(db, days, [], null, "2026-01-01T00:00:00.000Z");
  await db
    .prepare(`INSERT INTO forecast_v2_calendar_revisions
    (event_id,revision,kind,status,starts_at,ends_at,start_game_day,end_game_day,source_feed_ids_json,created_at)
    VALUES('e',1,'solo','confirmed','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',
    '2026-01-01','2026-01-02','[]','2026-01-01T00:00:00Z')`)
    .run();
  const ids = [
    ...Array.from({ length: 12 }, (_, i) => `old_${i.toString().padStart(2, "0")}`),
    "pending",
    "sending",
    "dead",
    "boundary",
    "recent",
  ];
  for (const [index, id] of ids.entries()) {
    const created =
      id === "boundary"
        ? "2026-02-01T00:00:00.000Z"
        : id === "recent"
          ? "2026-03-02T00:00:00.000Z"
          : "2026-01-01T00:00:00.000Z";
    await db.batch([
      db
        .prepare(`INSERT INTO forecast_v2_calendar_snapshots VALUES(?,?,?,?,?)`)
        .bind(id, "2026-01-01", "2026-01-01", (index + 1).toString(16).padStart(64, "0"), created),
      db.prepare(`INSERT INTO forecast_v2_calendar_days VALUES(?,'2026-01-01','{}')`).bind(id),
      db
        .prepare(`INSERT INTO forecast_v2_calendar_event_links VALUES(?,'2026-01-01','e',1)`)
        .bind(id),
      db
        .prepare(`INSERT INTO forecast_v2_calendar_diffs VALUES(?,?,?,'[]')`)
        .bind(active.snapshotId, id, id),
    ]);
  }
  for (const state of ["pending", "sending", "dead", "sent"]) {
    await db
      .prepare(`INSERT INTO forecast_v2_notification_outbox
      (outbox_id,idempotency_key,kind,snapshot_id,channel_role,payload_json,payload_hash,state,next_attempt_at,created_at,updated_at)
      VALUES(?,?,'calendar_changed',?,'activity','{}',?,?,0,?,?)`)
      .bind(
        state,
        state,
        state === "sent" ? "old_00" : state,
        "a".repeat(64),
        state,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      )
      .run();
  }
  const previous = { snapshotId: active.snapshotId, version: 1 };
  expect((await persistCalendar(db, days, [], previous, "2026-03-03T00:00:00.000Z")).changed).toBe(
    false,
  );
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM forecast_v2_calendar_snapshots WHERE snapshot_id LIKE 'old_%'",
      )
      .first("n"),
  ).toBe(2);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM forecast_v2_calendar_days WHERE snapshot_id LIKE 'old_%'")
      .first("n"),
  ).toBe(2);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM forecast_v2_calendar_event_links WHERE snapshot_id LIKE 'old_%'",
      )
      .first("n"),
  ).toBe(2);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM forecast_v2_calendar_diffs WHERE previous_snapshot_id LIKE 'old_%'",
      )
      .first("n"),
  ).toBe(2);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM forecast_v2_notification_outbox WHERE state='sent'")
      .first("n"),
  ).toBe(0);
  await persistCalendar(db, days, [], previous, "2026-03-03T00:00:00.000Z");
  const remaining = await db
    .prepare("SELECT snapshot_id FROM forecast_v2_calendar_snapshots ORDER BY snapshot_id")
    .all<{ snapshot_id: string }>();
  expect(remaining.results.map((row) => row.snapshot_id).sort()).toEqual(
    [active.snapshotId, "pending", "sending", "dead", "boundary", "recent"].sort(),
  );
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});
