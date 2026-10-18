import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { readActiveCalendar } from "../../../../forecast-admin/src/calendar";
import { executeTestSql } from "../../../../shared/testD1Sql";
import schema from "../../test-schema";
import { requestDecision } from "./decisions";
import { rebuildCalendar } from "./index";

it("reuses predicted-round identities and revises an overdue prediction", async () => {
  await reset();
  const db = env.FORECAST_DB;
  await executeTestSql(db, schema, applyD1Migrations);
  await db.batch([
    db.prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,start_game_day,end_game_day,
       prediction_provenance_json,source_feed_ids_json,created_at)
      VALUES('ancient_solo',1,'solo','confirmed','2000-01-01T00:00:00.000Z',
      '2000-01-08T00:00:00.000Z','2000-01-01','2000-01-08','{"round":999}',
      '[3]','2000-01-01T00:00:00.000Z')`),
    db.prepare(
      "INSERT INTO forecast_v2_calendar_heads(event_id,revision) VALUES('ancient_solo',1)",
    ),
    db.prepare(`UPDATE forecast_v2_monitor_state SET
      committed_created_at='2026-11-12T00:00:00.000Z',consecutive_holds=2 WHERE stream_id='G'`),
    db.prepare(`INSERT INTO forecast_v2_monitor_runs
      (run_id,stream_id,generation,kind,status,started_at,error_code)
      VALUES('held_G','G',1,'new','held','2026-11-13T00:00:00.000Z','boundary_missing')`),
    db.prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,start_game_day,end_game_day,
       prediction_provenance_json,source_feed_ids_json,created_at)
      VALUES('solo_41',1,'solo','confirmed','2026-09-17T03:00:00.000Z',
      '2026-09-23T19:59:59.000Z','2026-09-17','2026-09-23','{"round":41}',
      '[2]','2026-09-17T03:00:00.000Z')`),
    db.prepare("INSERT INTO forecast_v2_calendar_heads(event_id,revision) VALUES('solo_41',1)"),
    db.prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,start_game_day,end_game_day,
       prediction_provenance_json,source_feed_ids_json,created_at)
      VALUES('solo_42',1,'solo','confirmed','2026-10-15T03:00:00.000Z',
      '2026-10-21T19:59:59.000Z','2026-10-15','2026-10-21','{"round":42}',
      '[1]','2026-10-15T03:00:00.000Z')`),
    db.prepare("INSERT INTO forecast_v2_calendar_heads(event_id,revision) VALUES('solo_42',1)"),
  ]);
  const now = Date.parse("2026-11-13T04:00:00.000Z");
  await requestDecision(
    db,
    {
      id: "calendar_pending",
      type: "grant_date",
      environment: "staging",
      eventId: null,
      sourceHash: "a".repeat(64),
      feedIds: [1],
      title: "Pending grant",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      options: [{ id: "day", label: "2026-11-14" }],
    },
    new Date(now).toISOString(),
  );
  const first = await rebuildCalendar(db, now);
  const calendar = await readActiveCalendar(db);
  const notes = [...calendar!.days.values()].flatMap((day) => day.pending);
  expect(notes).toContain("Pending grant");
  expect(notes).toContain("결정 대기: grant_date");
  expect(notes).toContain("coverage A: never committed");
  expect(notes).toContain("coverage G: 2026-11-12T00:00:00.000Z");
  expect(notes).toContain("coverage G consecutive holds: 2");
  expect(notes).toContain("coverage G last hold: boundary_missing");
  expect(notes).toContain("https://game.naver.com/lounge/nikke/board/detail/1");
  expect(notes.some((note) => note.startsWith("expiresAt:"))).toBe(true);
  expect(await rebuildCalendar(db, now)).toEqual({ ...first, changed: false });
  await db
    .prepare(`UPDATE forecast_v2_monitor_state SET consecutive_holds=3,
    committed_created_at='2026-11-13T01:00:00.000Z' WHERE stream_id='G'`)
    .run();
  expect(await rebuildCalendar(db, now)).toEqual({ ...first, changed: false });
  const refreshed = await readActiveCalendar(db);
  expect(refreshed!.version).toBe(calendar!.version);
  expect([...refreshed!.days.values()].flatMap((day) => day.pending)).toContain(
    "coverage G consecutive holds: 3",
  );
  expect(await db.prepare("SELECT COUNT(*) n FROM forecast_v2_calendar_snapshots").first("n")).toBe(
    1,
  );
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM forecast_v2_notification_outbox WHERE kind='calendar_changed'",
      )
      .first("n"),
  ).toBe(0);
  await rebuildCalendar(db, now + 86_400_000);
  const revisions = await db
    .prepare(`SELECT event_id,revision FROM forecast_v2_calendar_revisions
    WHERE event_id='prediction_S43_primary' ORDER BY revision`)
    .all();
  expect(revisions.results).toEqual([
    { event_id: "prediction_S43_primary", revision: 1 },
    { event_id: "prediction_S43_primary", revision: 2 },
  ]);
  const diffs = await db
    .prepare("SELECT payload_json FROM forecast_v2_calendar_diffs")
    .all<{ payload_json: string }>();
  expect(diffs.results.flatMap((row) => JSON.parse(row.payload_json))).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "solo", change: "changed" })]),
  );
});
