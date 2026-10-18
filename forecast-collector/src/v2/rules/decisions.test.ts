import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { readActiveCalendar } from "../../../../forecast-admin/src/calendar";
import { executeTestSql } from "../../../../shared/testD1Sql";
import maintenanceFixture from "../../../fixtures/forecast-v2/details/4899747.json?raw";
import schema from "../../test-schema";
import { applyScheduleDecision } from "./apply-decisions";
import { applyGrantDecision } from "./apply-grants";
import {
  dueEFollowUps,
  maintainDecisions,
  refreshRevisionDecision,
  requestDecision,
} from "./decisions";
import { configureRules, processPostVersion, rebuildCalendar } from "./index";
import { maintenanceDependents } from "./maintenance-dependents";
import { applyPendingDecisions } from "./pending-decisions";
import { persistCalendar } from "./snapshot-store";
import { rejectStaleSource } from "./source-fence";

beforeEach(async () => {
  await reset();
  await executeTestSql(env.FORECAST_DB, schema, applyD1Migrations);
});
it("replays request and lifecycle units without duplicate notifications or extended expiry", async () => {
  const db = env.FORECAST_DB;
  const input = {
    id: "test_review",
    type: "solo_review" as const,
    environment: "staging" as const,
    eventId: null,
    sourceHash: "a".repeat(64),
    feedIds: [6252194],
    title: "솔로 레이드",
    url: "https://game.naver.com/lounge/nikke/board/detail/6252194",
    options: [],
  };
  const created = "2026-06-25T08:00:00.000Z";
  await requestDecision(db, input, created);
  const before = await db.prepare("SELECT * FROM forecast_v2_decision_requests").all();
  await requestDecision(db, input, "2026-06-26T08:00:00.000Z");
  expect((await db.prepare("SELECT * FROM forecast_v2_decision_requests").all()).results).toEqual(
    before.results,
  );
  expect(await dueEFollowUps(db, created)).toBe(1);
  await maintainDecisions(db, "2026-06-28T08:00:00.000Z");
  const reminded = await db
    .prepare("SELECT * FROM forecast_v2_notification_outbox ORDER BY outbox_id")
    .all();
  await maintainDecisions(db, "2026-06-29T08:00:00.000Z");
  expect(
    (await db.prepare("SELECT * FROM forecast_v2_notification_outbox ORDER BY outbox_id").all())
      .results,
  ).toEqual(reminded.results);
  expect(reminded.results).toHaveLength(2);
  await maintainDecisions(db, "2026-07-09T08:00:00.000Z");
  expect(await dueEFollowUps(db, "2026-07-09T08:00:00.000Z")).toBe(0);
  expect(await db.prepare("SELECT status FROM forecast_v2_decision_requests").first("status")).toBe(
    "expired",
  );
});

it("stores incomplete B reviews without a duplicate decision-request notification", async () => {
  const db = env.FORECAST_DB;
  await requestDecision(
    db,
    {
      id: "b_incomplete",
      type: "solo_review",
      environment: "staging",
      eventId: null,
      sourceHash: "a".repeat(64),
      feedIds: [6252194],
      title: "솔로 레이드",
      url: "https://game.naver.com/lounge/nikke/board/detail/6252194",
      options: [],
      suppressNotification: true,
    },
    "2026-06-25T08:00:00.000Z",
  );
  const json = await db
    .prepare("SELECT payload_json FROM forecast_v2_decision_requests")
    .first<string>("payload_json");
  expect(JSON.parse(json!).extracted.complete).toBe(false);
  expect((await db.prepare("SELECT * FROM forecast_v2_notification_outbox").all()).results).toEqual(
    [],
  );
});

it("terminates an incomplete confirmed result, reissues review, and drains the queue", async () => {
  const db = env.FORECAST_DB;
  const now = "2026-06-25T08:00:00.000Z";
  await requestDecision(
    db,
    {
      id: "incomplete_result",
      type: "solo_review",
      environment: "staging",
      eventId: null,
      sourceHash: "a".repeat(64),
      feedIds: [6252194],
      title: "솔로 레이드",
      url: "https://game.naver.com/lounge/nikke/board/detail/6252194",
      options: [],
    },
    now,
  );
  await db.batch([
    db
      .prepare("INSERT INTO forecast_v2_consumed_interactions VALUES(?,?,?)")
      .bind("i", "incomplete_result", now),
    db
      .prepare("INSERT INTO forecast_v2_decision_results VALUES(?,?,?,?)")
      .bind("incomplete_result", "i", JSON.stringify({ action: "bok" }), now),
    db
      .prepare("UPDATE forecast_v2_decision_requests SET status='resolved' WHERE decision_id=?")
      .bind("incomplete_result"),
  ]);
  expect(await applyPendingDecisions(db, Date.parse(now))).toEqual({
    applied: false,
    failure: "decision_schedule_missing",
  });
  expect(await applyPendingDecisions(db, Date.parse(now))).toEqual({ applied: false });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM forecast_v2_admin_commands WHERE decision_id='incomplete_result'",
      )
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM forecast_v2_decision_requests WHERE status='pending'")
      .first("n"),
  ).toBe(1);
});

it("fences old decision sources against the latest stored version", async () => {
  const db = env.FORECAST_DB;
  const now = "2026-06-25T08:00:00.000Z";
  await requestDecision(
    db,
    {
      id: "old_source",
      type: "grant_date",
      environment: "staging",
      eventId: null,
      sourceHash: "a".repeat(64),
      feedIds: [6252194],
      title: "지급",
      url: "https://game.naver.com/lounge/nikke/board/detail/6252194",
      options: [{ id: "date_0", label: "2026-06-25" }],
    },
    now,
  );
  await db
    .prepare(`INSERT INTO forecast_v2_post_versions
    (version_id,feed_id,updated_date,content_hash,board_id,created_at,fetched_at,body_text)
    VALUES(?,?,?,?,11,?,?,?)`)
    .bind("new", "6252194", now, "b".repeat(64), now, now, "edited")
    .run();
  expect(
    await rejectStaleSource(db, "old_source", { feedIds: [6252194], sourceHash: "a".repeat(64) }),
  ).toBe(true);
  expect(
    await db
      .prepare("SELECT status FROM forecast_v2_decision_requests WHERE decision_id='old_source'")
      .first("status"),
  ).toBe("stale");
});

it("reissues every pending request when its head revision advances", async () => {
  const db = env.FORECAST_DB;
  const now = "2026-06-25T08:00:00.000Z";
  for (const id of ["review1", "review2"]) {
    await requestDecision(
      db,
      {
        id,
        type: "maintenance",
        environment: "staging",
        eventId: "event",
        sourceHash: "c".repeat(64),
        feedIds: [6252194],
        title: "점검",
        url: "https://game.naver.com/lounge/nikke/board/detail/6252194",
        options: [{ id: "ignore", label: "관련 없음" }],
      },
      now,
    );
  }
  await db.batch([
    db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,source_feed_ids_json,created_at)
      VALUES('event',1,'maintenance','pending','[]',?)`)
      .bind(now),
    db.prepare("INSERT INTO forecast_v2_calendar_heads VALUES('event',1)"),
  ]);
  await refreshRevisionDecision(db, now);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM forecast_v2_decision_requests WHERE status='stale'")
      .first("n"),
  ).toBe(2);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM forecast_v2_decision_requests WHERE status='pending' AND expected_calendar_revision=1",
      )
      .first("n"),
  ).toBe(2);
  await refreshRevisionDecision(db, now);
  expect(await db.prepare("SELECT COUNT(*) n FROM forecast_v2_decision_requests").first("n")).toBe(
    4,
  );
});

it.each([
  ["maintenance", "edit"],
  ["collaboration", "edit"],
  ["maintenance", "opt"],
  ["collaboration", "opt"],
] as const)("applies %s schedule result %s", async (type, action) => {
  const db = env.FORECAST_DB;
  const now = "2026-06-25T08:00:00.000Z";
  await requestDecision(
    db,
    {
      id: "edit_review",
      type,
      environment: "staging",
      eventId: null,
      sourceHash: "c".repeat(64),
      feedIds: [6252194],
      title: "검토",
      url: "https://game.naver.com/lounge/nikke/board/detail/6252194",
      options: [
        { id: "window_0", label: "일시 확인", startAt: now, endAt: "2026-07-23T08:00:00.000Z" },
      ],
    },
    now,
  );
  await db.batch([
    db
      .prepare("INSERT INTO forecast_v2_consumed_interactions VALUES('edit_i','edit_review',?)")
      .bind(now),
    db
      .prepare("INSERT INTO forecast_v2_decision_results VALUES('edit_review','edit_i',?,?)")
      .bind(
        JSON.stringify(
          action === "edit"
            ? { action, startAt: now, endAt: "2026-07-23T08:00:00.000Z" }
            : { action, optionId: "window_0" },
        ),
        now,
      ),
    db.prepare(
      "UPDATE forecast_v2_decision_requests SET status='resolved' WHERE decision_id='edit_review'",
    ),
  ]);
  expect(await applyPendingDecisions(db, Date.parse(now))).toEqual({ applied: true });
  expect(await db.prepare("SELECT kind FROM forecast_v2_calendar_revisions").first("kind")).toBe(
    type,
  );
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

it("moves the same feed's occurrence when an edited grant date is confirmed", async () => {
  const db = env.FORECAST_DB;
  for (const day of [25, 26]) {
    const id = `edit_${day}`;
    const date = `2026-06-${day}`;
    const now = `${date}T08:00:00.000Z`;
    const sourceHash = String(day).repeat(32);
    await db.batch([
      db
        .prepare(`INSERT INTO forecast_v2_post_versions VALUES(?,'6252194',?,?,11,?,?,'body')`)
        .bind(id, now, sourceHash, now, now),
      db
        .prepare(
          `INSERT INTO forecast_v2_grant_observations VALUES(?,?,'6252194',10,5,?,'in_post_datetime',?)`,
        )
        .bind(id, id, JSON.stringify([{ date, instant: null }]), now),
    ]);
    await requestDecision(
      db,
      {
        id,
        type: "grant_date",
        environment: "staging",
        eventId: null,
        sourceHash,
        feedIds: [6252194],
        title: "지급",
        url: "https://game.naver.com/lounge/nikke/board/detail/6252194",
        options: [{ id: "date_0", label: date }],
      },
      now,
    );
    await db.batch([
      db.prepare("INSERT INTO forecast_v2_consumed_interactions VALUES(?,?,?)").bind(id, id, now),
      db
        .prepare("INSERT INTO forecast_v2_decision_results VALUES(?,?,?,?)")
        .bind(id, id, JSON.stringify({ action: "opt", optionId: "date_0" }), now),
      db
        .prepare("UPDATE forecast_v2_decision_requests SET status='resolved' WHERE decision_id=?")
        .bind(id),
    ]);
    expect(await applyPendingDecisions(db, Date.parse(now))).toEqual({ applied: true });
  }
  const heads = (
    await db.prepare("SELECT grant_game_day,ii_qty,box_qty FROM forecast_v2_grant_heads").all()
  ).results;
  expect(heads).toEqual([{ grant_game_day: "2026-06-26", ii_qty: 10, box_qty: 5 }]);
  expect(await db.prepare("SELECT COUNT(*) n FROM forecast_v2_grant_links").first("n")).toBe(1);
});

it("applies a selected midnight grant once and uses the preceding game day", async () => {
  const db = env.FORECAST_DB;
  const now = "2026-06-25T08:00:00.000Z";
  await db.batch([
    db
      .prepare(
        `INSERT INTO forecast_v2_post_versions VALUES('grant_version','6252194',?,?,11,?,?,'body')`,
      )
      .bind(now, "c".repeat(64), now, now),
    db
      .prepare(
        `INSERT INTO forecast_v2_grant_observations VALUES('obs','grant_version','6252194',10,5,?,'in_post_datetime',?)`,
      )
      .bind(JSON.stringify([{ date: "2026-06-26", instant: "2026-06-26T00:00:00+09:00" }]), now),
  ]);
  await requestDecision(
    db,
    {
      id: "grant_review",
      type: "grant_date",
      environment: "staging",
      eventId: null,
      sourceHash: "c".repeat(64),
      feedIds: [6252194],
      title: "관리 키트 보상",
      url: "https://game.naver.com/lounge/nikke/board/detail/6252194",
      options: [{ id: "date_0", label: "2026-06-26T00:00:00+09:00" }],
    },
    now,
  );
  await db.batch([
    db
      .prepare(
        "INSERT INTO forecast_v2_consumed_interactions VALUES('grant_interaction','grant_review',?)",
      )
      .bind(now),
    db
      .prepare(
        "INSERT INTO forecast_v2_decision_results VALUES('grant_review','grant_interaction',?,?)",
      )
      .bind(
        JSON.stringify({
          action: "opt",
          optionId: "date_0",
          expectedRevision: 0,
          actorId: "test",
          decidedAt: now,
        }),
        now,
      ),
    db.prepare(
      "UPDATE forecast_v2_decision_requests SET status='resolved' WHERE decision_id='grant_review'",
    ),
  ]);
  expect(await applyGrantDecision(db, now)).toBe(true);
  const before = (await db.prepare("SELECT * FROM forecast_v2_grant_heads").all()).results;
  expect(before).toMatchObject([{ grant_game_day: "2026-06-25", ii_qty: 10, box_qty: 5 }]);
  expect(await applyGrantDecision(db, now)).toBe(false);
  expect((await db.prepare("SELECT * FROM forecast_v2_grant_heads").all()).results).toEqual(before);
});

it.each([
  ["maintenance", "use_source", true],
  ["collaboration", "new", true],
  ["collaboration", "same", false],
  ["maintenance", "ignore", false],
] as const)("applies %s option %s once", async (type, optionId, changed) => {
  const db = env.FORECAST_DB;
  const now = "2026-06-25T08:00:00.000Z";
  await requestDecision(
    db,
    {
      id: "option_review",
      type,
      environment: "staging",
      eventId: "event_option",
      sourceHash: "d".repeat(64),
      feedIds: [4899747],
      title: "일정 확인",
      url: "https://game.naver.com/lounge/nikke/board/detail/4899747",
      options: [{ id: optionId, label: optionId }],
      extracted: { startAt: "2026-07-03T12:00:00+09:00", endAt: "2026-07-31T04:59:59+09:00" },
    },
    now,
  );
  await db.batch([
    db
      .prepare(
        "INSERT INTO forecast_v2_consumed_interactions VALUES('option_interaction','option_review',?)",
      )
      .bind(now),
    db
      .prepare(
        "INSERT INTO forecast_v2_decision_results VALUES('option_review','option_interaction',?,?)",
      )
      .bind(
        JSON.stringify({
          action: "opt",
          optionId,
          expectedRevision: 0,
          actorId: "test",
          decidedAt: now,
        }),
        now,
      ),
    db.prepare(
      "UPDATE forecast_v2_decision_requests SET status='resolved' WHERE decision_id='option_review'",
    ),
  ]);
  expect(await applyScheduleDecision(db, now)).toBe(changed);
  expect(await applyScheduleDecision(db, now)).toBe(false);
  expect(
    await db.prepare("SELECT COUNT(*) AS n FROM forecast_v2_calendar_revisions").first("n"),
  ).toBe(Number(changed));
  expect(await db.prepare("SELECT COUNT(*) AS n FROM forecast_v2_admin_commands").first("n")).toBe(
    1,
  );
});

it("advances maintenance-dependent solo and collaboration heads atomically", async () => {
  const db = env.FORECAST_DB;
  const now = "2026-07-03T02:00:00.000Z";
  await db.batch([
    db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,start_game_day,end_game_day,source_feed_ids_json,created_at)
      VALUES('m',1,'maintenance','confirmed','2026-07-02T20:00:00.000Z','2026-07-03T03:00:00.000Z','2026-07-03','2026-07-03','[]',?)`)
      .bind(now),
    db.prepare("INSERT INTO forecast_v2_calendar_heads VALUES('m',1)"),
    ...(["solo", "collaboration"] as const).flatMap((kind) => [
      db
        .prepare(`INSERT INTO forecast_v2_calendar_revisions
        (event_id,revision,kind,status,starts_at,ends_at,start_game_day,end_game_day,maintenance_event_id,maintenance_revision,source_feed_ids_json,created_at)
        VALUES(?,1,?,'confirmed','2026-07-03T03:00:00.000Z','2026-07-30T19:59:59.000Z','2026-07-03','2026-07-30','m',1,'[]',?)`)
        .bind(kind, kind, now),
      db.prepare("INSERT INTO forecast_v2_calendar_heads VALUES(?,1)").bind(kind),
    ]),
  ]);
  const changed = await maintenanceDependents(
    db,
    "m",
    2,
    "2026-07-03T03:00:00.000Z",
    "2026-07-03T06:00:00.000Z",
    now,
  );
  await db.batch([
    db.prepare(`INSERT INTO forecast_v2_calendar_revisions
      SELECT event_id,2,kind,status,starts_at,'2026-07-03T06:00:00.000Z',start_game_day,end_game_day,
      maintenance_event_id,maintenance_revision,prediction_provenance_json,source_feed_ids_json,created_at
      FROM forecast_v2_calendar_revisions WHERE event_id='m' AND revision=1`),
    db.prepare("UPDATE forecast_v2_calendar_heads SET revision=2 WHERE event_id='m'"),
    ...changed,
  ]);
  const rows = await db
    .prepare(`SELECT starts_at,maintenance_revision FROM forecast_v2_calendar_revisions
    WHERE revision=2 AND kind IN ('solo','collaboration')`)
    .all();
  expect(rows.results).toEqual([
    { starts_at: "2026-07-03T06:00:00.000Z", maintenance_revision: 2 },
    { starts_at: "2026-07-03T06:00:00.000Z", maintenance_revision: 2 },
  ]);
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

it("deduplicates A/B/F grant evidence by version while reporting only B", async () => {
  configureRules({ environment: "staging" });
  const db = env.FORECAST_DB;
  const now = "2026-06-25T08:00:00.000Z";
  const body =
    "전체 지휘관 우편 보상\n보상 지급일: 6/26 00:00\n관리 키트 상자 II ×10\n관리 키트 상자 ×5";
  await db.batch([
    db
      .prepare(`INSERT INTO forecast_v2_monitor_runs
      (run_id,stream_id,generation,kind,status,started_at) VALUES('shared','A',1,'new','completed',?)`)
      .bind(now),
    db
      .prepare("INSERT INTO forecast_v2_search_hits VALUES('shared','6252194',?,?,?)")
      .bind(now, now, JSON.stringify({ title: "솔로 레이드 보상 안내" })),
    db
      .prepare(
        "INSERT INTO forecast_v2_post_versions VALUES('shared_version','6252194',?,?,11,?,?,?)",
      )
      .bind(now, "e".repeat(64), now, now, body),
  ]);
  for (const monitorId of ["A", "B", "F"] as const) {
    await processPostVersion(
      db,
      { monitorId, feedId: "6252194", versionId: "shared_version" },
      Date.parse(now),
    );
    expect(
      await db
        .prepare(`SELECT COUNT(*) AS n FROM forecast_v2_notification_outbox
      WHERE kind='b_report'`)
        .first("n"),
    ).toBe(monitorId === "A" ? 0 : 1);
  }
  for (const table of [
    "forecast_v2_grant_observations",
    "forecast_v2_grant_revisions",
    "forecast_v2_grant_heads",
    "forecast_v2_grant_links",
  ]) {
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n")).toBe(1);
  }
  const before = (
    await db.prepare("SELECT * FROM forecast_v2_notification_outbox ORDER BY outbox_id").all()
  ).results;
  for (const monitorId of ["A", "B", "F"] as const)
    await processPostVersion(
      db,
      { monitorId, feedId: "6252194", versionId: "shared_version" },
      Date.parse(now),
    );
  expect(
    (await db.prepare("SELECT * FROM forecast_v2_notification_outbox ORDER BY outbox_id").all())
      .results,
  ).toEqual(before);
});

it.each([10, 20])("reconciles maintenance-date collision with target II=%s", async (targetQty) => {
  const db = env.FORECAST_DB;
  const now = "2026-07-03T18:00:00.000Z";
  const oldEnd = "2026-07-03T19:00:00.000Z",
    newEnd = "2026-07-03T20:00:00.000Z";
  await db.batch([
    db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,source_feed_ids_json,created_at)
      VALUES('m',1,'maintenance','confirmed',?,?, '[]',?)`)
      .bind(now, oldEnd, now),
    db.prepare("INSERT INTO forecast_v2_calendar_heads VALUES('m',1)"),
    db
      .prepare("INSERT INTO forecast_v2_post_versions VALUES('mv','999',?,?,48,?,?, 'body')")
      .bind(now, "f".repeat(64), now, now),
    db
      .prepare(
        "INSERT INTO forecast_v2_grant_observations VALUES('mo','mv','999',10,0,?,'maintenance_end',?)",
      )
      .bind(JSON.stringify([oldEnd]), now),
    db
      .prepare(`INSERT INTO forecast_v2_grant_revisions VALUES('old',1,'2026-07-03',10,0,NULL,?)`)
      .bind(now),
    db.prepare("INSERT INTO forecast_v2_grant_heads VALUES('old',1,'2026-07-03',10,0)"),
    db.prepare("INSERT INTO forecast_v2_grant_links VALUES('old_link','old','mo',NULL)"),
    db
      .prepare(`INSERT INTO forecast_v2_grant_revisions VALUES('target',1,'2026-07-04',?,0,NULL,?)`)
      .bind(targetQty, now),
    db
      .prepare("INSERT INTO forecast_v2_grant_heads VALUES('target',1,'2026-07-04',?,0)")
      .bind(targetQty),
  ]);
  await db.batch(await maintenanceDependents(db, "m", 2, oldEnd, newEnd, now, "staging"));
  expect(await db.prepare("SELECT COUNT(*) AS n FROM forecast_v2_grant_heads").first("n")).toBe(1);
  expect(await db.prepare("SELECT SUM(ii_qty) AS n FROM forecast_v2_grant_heads").first("n")).toBe(
    targetQty,
  );
  expect(
    await db.prepare("SELECT COUNT(*) AS n FROM forecast_v2_grant_observations").first("n"),
  ).toBe(1);
  if (targetQty === 10) {
    expect(
      await db
        .prepare("SELECT occurrence_id FROM forecast_v2_grant_links WHERE observation_id='mo'")
        .first("occurrence_id"),
    ).toBe("target");
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM forecast_v2_decision_requests").first("n"),
    ).toBe(0);
  } else {
    expect(await db.prepare("SELECT type FROM forecast_v2_decision_requests").first("type")).toBe(
      "grant_quantity",
    );
  }
});
