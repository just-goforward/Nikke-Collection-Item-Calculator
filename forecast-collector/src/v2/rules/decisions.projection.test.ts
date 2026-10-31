import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { readActiveCalendar } from "../../../../forecast-admin/src/calendar";
import { executeTestSql } from "../../../../shared/testD1Sql";
import maintenanceFixture from "../../../fixtures/forecast-v2/details/4899747.json?raw";
import schema from "../../test-schema";
import { applyScheduleDecision } from "./apply-decisions";
import { requestDecision } from "./decisions";
import { configureRules, processPostVersion, rebuildCalendar } from "./index";
import { applyPendingDecisions } from "./pending-decisions";
import { persistCalendar } from "./snapshot-store";

beforeEach(async () => {
  await reset();
  await executeTestSql(env.FORECAST_DB, schema, applyD1Migrations);
});

it("applies an immutable edited schedule only once", async () => {
  const db = env.FORECAST_DB;
  const now = "2026-06-25T08:00:00.000Z";
  await requestDecision(
    db,
    {
      id: "edit_review",
      type: "solo_review",
      environment: "staging",
      eventId: "solo_26",
      sourceHash: "b".repeat(64),
      feedIds: [6280133],
      title: "솔로 레이드",
      url: "https://game.naver.com/lounge/nikke/board/detail/6280133",
      options: [],
    },
    now,
  );
  await db.batch([
    db
      .prepare(
        "INSERT INTO forecast_v2_consumed_interactions VALUES('interaction','edit_review',?)",
      )
      .bind(now),
    db
      .prepare("INSERT INTO forecast_v2_decision_results VALUES('edit_review','interaction',?,?)")
      .bind(
        JSON.stringify({
          action: "edit",
          startAt: "2026-07-03T12:00:00+09:00",
          endAt: "2026-07-10T04:59:59+09:00",
          expectedRevision: 0,
          actorId: "test",
          decidedAt: now,
        }),
        now,
      ),
    db.prepare(
      "UPDATE forecast_v2_decision_requests SET status='resolved' WHERE decision_id='edit_review'",
    ),
  ]);
  expect(await applyScheduleDecision(db, now)).toBe(true);
  const revisions = (await db.prepare("SELECT * FROM forecast_v2_calendar_revisions").all())
    .results;
  const commands = (await db.prepare("SELECT * FROM forecast_v2_admin_commands").all()).results;
  expect(await applyScheduleDecision(db, now)).toBe(false);
  expect((await db.prepare("SELECT * FROM forecast_v2_calendar_revisions").all()).results).toEqual(
    revisions,
  );
  expect((await db.prepare("SELECT * FROM forecast_v2_admin_commands").all()).results).toEqual(
    commands,
  );
  expect(commands).toHaveLength(1);
  expect(revisions).toHaveLength(1);
});

it("keeps content-identical snapshots unchanged and rolls back a stale projection fence", async () => {
  const db = env.FORECAST_DB;
  const now = "2026-06-25T08:00:00.000Z";
  const days = [{ gameDay: "2026-06-25", events: [], grants: [], ii: 0, box: 0 }];
  const first = await persistCalendar(db, days, [], null, now);
  const before = (await db.prepare("SELECT * FROM forecast_v2_calendar_active").all()).results;
  expect(
    await persistCalendar(db, days, [], { snapshotId: first.snapshotId, version: 1 }, now),
  ).toEqual({ snapshotId: first.snapshotId, changed: false });
  expect((await db.prepare("SELECT * FROM forecast_v2_calendar_active").all()).results).toEqual(
    before,
  );
  const next = [{ ...days[0]!, ii: 5 }];
  await expect(
    persistCalendar(db, next, [], { snapshotId: first.snapshotId, version: 0 }, now),
  ).rejects.toThrow();
  expect(
    await db.prepare("SELECT COUNT(*) AS n FROM forecast_v2_calendar_snapshots").first("n"),
  ).toBe(1);
  expect((await db.prepare("SELECT * FROM forecast_v2_calendar_active").all()).results).toEqual(
    before,
  );
});

it("routes a captured G version and replays processing and rebuilding without extra rows", async () => {
  configureRules({ environment: "staging" });
  const db = env.FORECAST_DB;
  const feed = JSON.parse(maintenanceFixture).content.feed;
  const created = "2024-10-14T10:01:43.000Z";
  await db.batch([
    db
      .prepare(`INSERT INTO forecast_v2_monitor_runs
      (run_id,stream_id,generation,kind,status,started_at) VALUES('fixture','G',1,'new','completed',?)`)
      .bind(created),
    db
      .prepare(`INSERT INTO forecast_v2_search_hits VALUES('fixture','4899747',?,?,?)`)
      .bind(created, created, JSON.stringify({ title: feed.title })),
    db
      .prepare(
        `INSERT INTO forecast_v2_post_versions VALUES('fixture_version','4899747',?,? ,48,?,?,?)`,
      )
      .bind(created, "a".repeat(64), created, created, feed.contents),
  ]);
  const now = Date.parse("2026-10-18T08:00:00.000Z");
  const input = { monitorId: "G" as const, feedId: "4899747", versionId: "fixture_version" };
  expect(await processPostVersion(db, input, now)).toMatchObject({ calendarDirty: true });
  const revisions = (await db.prepare("SELECT * FROM forecast_v2_calendar_revisions").all())
    .results;
  expect(await processPostVersion(db, input, now)).toEqual({
    calendarDirty: false,
    decisionRequests: 0,
    grants: 0,
  });
  expect((await db.prepare("SELECT * FROM forecast_v2_calendar_revisions").all()).results).toEqual(
    revisions,
  );
  const first = await rebuildCalendar(db, now);
  expect(first.changed).toBe(true);
  expect(await rebuildCalendar(db, now)).toEqual({ snapshotId: first.snapshotId, changed: false });
  expect(
    await db.prepare("SELECT COUNT(*) AS n FROM forecast_v2_calendar_snapshots").first("n"),
  ).toBe(1);
  const rendered = await readActiveCalendar(db);
  expect(rendered?.snapshotId).toBe(first.snapshotId);
  expect(rendered?.days.size).toBe(32);
  for (const day of rendered!.days.values()) {
    expect([0, 5, 10]).toContain(day.coop);
    expect(day.kits.ii).toBeGreaterThanOrEqual(day.coop);
  }
});

it.each([
  ["maintenance", "bad", "schedule_decision_option_invalid"],
  ["maintenance", "unsupported", "schedule_decision_option_unsupported"],
  ["grant_date", "bad", "grant_decision_option_invalid"],
  ["grant_date", "unsupported", "grant_decision_observation_missing"],
  ["grant_quantity", "correction", "grant_correction_target_ambiguous"],
] as const)("terminates %s result error %s", async (type, optionId, failure) => {
  const db = env.FORECAST_DB;
  const now = "2026-06-25T08:00:00.000Z";
  if (type === "grant_quantity") {
    await db.batch([
      db
        .prepare(`INSERT INTO forecast_v2_post_versions VALUES('v','6252194',?,?,11,?,?,'body')`)
        .bind(now, "c".repeat(64), now, now),
      db
        .prepare(
          `INSERT INTO forecast_v2_grant_observations VALUES('o','v','6252194',10,5,?,'in_post_datetime',?)`,
        )
        .bind(JSON.stringify([{ date: "2026-06-25", instant: null }]), now),
    ]);
  }
  await requestDecision(
    db,
    {
      id: "error_review",
      type,
      environment: "staging",
      eventId: null,
      sourceHash: "c".repeat(64),
      feedIds: [6252194],
      title: "검토",
      url: "https://game.naver.com/lounge/nikke/board/detail/6252194",
      options: [
        { id: "unsupported", label: "2026-06-25" },
        { id: "correction", label: "정정" },
      ],
    },
    now,
  );
  await db.batch([
    db
      .prepare("INSERT INTO forecast_v2_consumed_interactions VALUES('error_i','error_review',?)")
      .bind(now),
    db
      .prepare("INSERT INTO forecast_v2_decision_results VALUES('error_review','error_i',?,?)")
      .bind(JSON.stringify({ action: "opt", optionId }), now),
    db.prepare(
      "UPDATE forecast_v2_decision_requests SET status='resolved' WHERE decision_id='error_review'",
    ),
  ]);
  expect(await applyPendingDecisions(db, Date.parse(now))).toEqual({ applied: false, failure });
  expect(await applyPendingDecisions(db, Date.parse(now))).toEqual({ applied: false });
});

it("stores the admin day contract and batches notifications at the active version", async () => {
  const db = env.FORECAST_DB;
  const now = "2026-06-25T08:00:00.000Z";
  const base = { gameDay: "2026-06-25", events: [], grants: [], ii: 0, box: 0, coop: 0 as const };
  const first = await persistCalendar(db, [base], [], null, now);
  const second = await persistCalendar(
    db,
    [
      {
        ...base,
        ii: 10,
        box: 5,
        grants: [{ id: "g", gameDay: base.gameDay, ii: 10, box: 5 }],
      },
    ],
    [{ kind: "grant", label: "g", change: "added" }],
    { snapshotId: first.snapshotId, version: 1 },
    now,
  );
  await persistCalendar(
    db,
    [
      {
        ...base,
        ii: 20,
        box: 5,
        grants: [{ id: "g", gameDay: base.gameDay, ii: 20, box: 5 }],
      },
    ],
    [{ kind: "grant", label: "g", change: "changed" }],
    { snapshotId: second.snapshotId, version: 2 },
    now,
  );
  const calendar = await readActiveCalendar(db);
  expect(calendar?.days.get(base.gameDay)).toMatchObject({
    kits: { ii: 20, box: 5 },
    coop: 0,
    grants: [{ label: "g", ii: 20, box: 5 }],
  });
  const outbox = (
    await db
      .prepare("SELECT payload_json FROM forecast_v2_notification_outbox")
      .all<{ payload_json: string }>()
  ).results;
  expect(outbox).toHaveLength(1);
  expect(JSON.parse(outbox[0]!.payload_json)).toMatchObject({
    revision: calendar!.version,
    snapshotId: calendar!.snapshotId,
  });
});
