import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { executeTestSql } from "../../../../shared/testD1Sql";
import schema from "../../test-schema";
import { applyScheduleDecision } from "./apply-decisions";
import { applyGrantDecision } from "./apply-grants";
import { requestDecision } from "./decisions";

beforeEach(async () => {
  await reset();
  await executeTestSql(env.FORECAST_DB, schema, applyD1Migrations);
});

it.each(["grant_date", "maintenance"] as const)("fences an interleaved %s result", async (type) => {
  const db = env.FORECAST_DB;
  const now = "2026-06-25T08:00:00.000Z";
  const newer = "2026-06-26T08:00:00.000Z";
  await db
    .prepare("INSERT INTO forecast_v2_post_versions VALUES('old','6252194',?,?,11,?,?,'body')")
    .bind(now, "a".repeat(64), now, now)
    .run();
  await db
    .prepare(`INSERT INTO forecast_v2_grant_observations
    VALUES('obs','old','6252194',10,5,?,'in_post_datetime',?)`)
    .bind(JSON.stringify([{ date: "2026-06-25", instant: null }]), now)
    .run();
  await requestDecision(
    db,
    {
      id: "review",
      type,
      environment: "staging",
      eventId: null,
      sourceHash: "a".repeat(64),
      sourceVersion: "old",
      feedIds: [6252194],
      title: "검토",
      url: "https://game.naver.com/lounge/nikke/board/detail/6252194",
      options: [{ id: "date_0", label: "2026-06-25" }],
    },
    now,
  );
  await db.batch([
    db.prepare("INSERT INTO forecast_v2_consumed_interactions VALUES('i','review',?)").bind(now),
    db
      .prepare("INSERT INTO forecast_v2_decision_results VALUES('review','i',?,?)")
      .bind(
        JSON.stringify(
          type === "grant_date"
            ? { action: "opt", optionId: "date_0" }
            : { action: "edit", startAt: now, endAt: newer },
        ),
        now,
      ),
    db.prepare(
      "UPDATE forecast_v2_decision_requests SET status='resolved' WHERE decision_id='review'",
    ),
  ]);
  const batch = db.batch.bind(db);
  const spy = vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
    await db
      .prepare("INSERT INTO forecast_v2_post_versions VALUES('new','6252194',?,?,11,?,?,'edited')")
      .bind(newer, "b".repeat(64), now, newer)
      .run();
    return batch(statements);
  });
  const apply = type === "grant_date" ? applyGrantDecision : applyScheduleDecision;
  try {
    expect(await apply(db, newer)).toBe(false);
    expect(await apply(db, newer)).toBe(false);
  } finally {
    spy.mockRestore();
  }
  for (const table of ["admin_commands", "calendar_revisions", "grant_revisions", "grant_links"]) {
    expect(await db.prepare(`SELECT COUNT(*) n FROM forecast_v2_${table}`).first("n")).toBe(0);
  }
  expect(
    await db
      .prepare("SELECT status FROM forecast_v2_decision_requests WHERE decision_id='review'")
      .first("status"),
  ).toBe("stale");
  const pending = (
    await db
      .prepare("SELECT payload_json FROM forecast_v2_decision_requests WHERE status='pending'")
      .all<{ payload_json: string }>()
  ).results;
  expect(pending).toHaveLength(1);
  expect(JSON.parse(pending[0]!.payload_json).sourceVersion).toBe("new");
});
