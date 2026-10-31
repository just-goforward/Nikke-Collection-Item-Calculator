import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { executeTestSql } from "../../../../shared/testD1Sql";
import schema from "../../test-schema";
import { applyScheduleDecision } from "./apply-decisions";
import { requestDecision } from "./decisions";
import { postDependencies } from "./post-dependencies";
import { maintenanceConflictOptions } from "./schedule-options";

beforeEach(async () => {
  await reset();
  await executeTestSql(env.FORECAST_DB, schema, applyD1Migrations);
});
const now = "2026-06-25T08:00:00.000Z";
async function event(id: string, kind: string, start: string, end: string) {
  await env.FORECAST_DB.batch([
    env.FORECAST_DB.prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,source_feed_ids_json,created_at)
      VALUES(?,1,?,'confirmed',?,?,'[1]',?)`).bind(id, kind, start, end, now),
    env.FORECAST_DB.prepare("INSERT INTO forecast_v2_calendar_heads VALUES(?,1)").bind(id),
  ]);
}
it("excludes unrelated historical collaborations from post dependencies", async () => {
  await event("old", "collaboration", "2024-01-01T00:00:00Z", "2024-01-28T00:00:00Z");
  await event("current", "collaboration", now, "2026-07-23T00:00:00Z");
  const result = await postDependencies(env.FORECAST_DB, "2", {
    title: "콜라보",
    body: "진행 기간 6/25 ~ 7/23",
    postedAt: now,
  });
  expect(result.results.map((value) => value.id)).toEqual(["current"]);
});
it.each(["source_1", "window_1"])(
  "updates the selected existing conflict using %s",
  async (optionId) => {
    const db = env.FORECAST_DB;
    const endAt = "2026-06-25T12:00:00.000Z";
    await event("m1", "maintenance", now, endAt);
    await event("m2", "maintenance", now, endAt);
    const conflicts = ["m1", "m2"].map((id) => ({ id, startAt: now, endAt, revision: 1 }));
    await requestDecision(
      db,
      {
        id: "review",
        type: "maintenance",
        environment: "staging",
        eventId: null,
        sourceHash: "a".repeat(64),
        feedIds: [2],
        title: "점검",
        url: "https://game.naver.com/lounge/nikke/board/detail/2",
        options: maintenanceConflictOptions({ startAt: now, endAt }, conflicts),
      },
      now,
    );
    await db.batch([
      db.prepare("INSERT INTO forecast_v2_consumed_interactions VALUES('i','review',?)").bind(now),
      db
        .prepare("INSERT INTO forecast_v2_decision_results VALUES('review','i',?,?)")
        .bind(JSON.stringify({ action: "opt", optionId }), now),
      db.prepare(
        "UPDATE forecast_v2_decision_requests SET status='resolved' WHERE decision_id='review'",
      ),
    ]);
    expect(await applyScheduleDecision(db, now)).toBe(true);
    expect(
      (await db.prepare("SELECT * FROM forecast_v2_calendar_heads ORDER BY event_id").all())
        .results,
    ).toEqual([
      { event_id: "m1", revision: 1 },
      { event_id: "m2", revision: 2 },
    ]);
  },
);
