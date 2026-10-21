import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { executeTestSql } from "../../../../shared/testD1Sql";
import schema from "../../test-schema";
import {
  dueEFollowUps,
  maintainDecisions,
  refreshRevisionDecision,
  requestDecision,
} from "./decisions";
import { applyPendingDecisions } from "./pending-decisions";
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
