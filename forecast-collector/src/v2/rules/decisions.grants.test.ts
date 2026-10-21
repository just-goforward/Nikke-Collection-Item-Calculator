import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { executeTestSql } from "../../../../shared/testD1Sql";
import schema from "../../test-schema";
import { applyScheduleDecision } from "./apply-decisions";
import { applyGrantDecision } from "./apply-grants";
import { requestDecision } from "./decisions";
import { configureRules, processPostVersion } from "./index";
import { maintenanceDependents } from "./maintenance-dependents";
import { applyPendingDecisions } from "./pending-decisions";

beforeEach(async () => {
  await reset();
  await executeTestSql(env.FORECAST_DB, schema, applyD1Migrations);
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
