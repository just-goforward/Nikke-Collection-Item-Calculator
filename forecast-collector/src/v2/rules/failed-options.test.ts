import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { executeTestSql } from "../../../../shared/testD1Sql";
import schema from "../../test-schema";
import { requestDecision } from "./decisions";
import { applyPendingDecisions } from "./pending-decisions";

beforeEach(async () => {
  await reset();
  await executeTestSql(env.FORECAST_DB, schema, applyD1Migrations);
});

it.each([
  ["maintenance", false],
  ["collaboration", false],
  ["maintenance", true],
  ["grant_date", false],
  ["grant_quantity", false],
  ["grant_date", true],
] as const)("removes the failing option for %s (alternative=%s)", async (type, alternative) => {
  const db = env.FORECAST_DB;
  const now = "2026-06-25T08:00:00.000Z";
  await requestDecision(
    db,
    {
      id: "review",
      type,
      environment: "staging",
      eventId: null,
      sourceHash: "a".repeat(64),
      feedIds: [2],
      title: "검토",
      url: "https://game.naver.com/lounge/nikke/board/detail/2",
      options: [
        { id: "bad", label: "실패" },
        ...(alternative ? [{ id: "remaining", label: "2026-06-25" }] : []),
      ],
      extracted: { startAt: now, endAt: now },
    },
    now,
  );
  await db.batch([
    db.prepare("INSERT INTO forecast_v2_consumed_interactions VALUES('i','review',?)").bind(now),
    db
      .prepare("INSERT INTO forecast_v2_decision_results VALUES('review','i',?,?)")
      .bind(JSON.stringify({ action: "opt", optionId: "bad" }), now),
    db.prepare(
      "UPDATE forecast_v2_decision_requests SET status='resolved' WHERE decision_id='review'",
    ),
  ]);
  expect((await applyPendingDecisions(db, Date.parse(now))).failure).toBeDefined();
  expect(await applyPendingDecisions(db, Date.parse(now))).toEqual({ applied: false });
  const requests = (
    await db
      .prepare("SELECT payload_json FROM forecast_v2_decision_requests WHERE status='pending'")
      .all<{ payload_json: string }>()
  ).results;
  const exhaustedGrant = type.startsWith("grant_") && !alternative;
  expect(requests).toHaveLength(exhaustedGrant ? 0 : 1);
  if (!exhaustedGrant) {
    const payload = JSON.parse(requests[0]!.payload_json);
    expect(payload.options).toEqual(alternative ? [{ id: "remaining", label: "2026-06-25" }] : []);
    if (!alternative) expect(payload.extracted).toBeUndefined();
  }
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM forecast_ops_alerts WHERE error_code='grant_decision_options_exhausted'",
      )
      .first("n"),
  ).toBe(exhaustedGrant ? 1 : 0);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM forecast_v2_admin_commands WHERE decision_id='review'")
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare("SELECT status FROM forecast_v2_decision_requests WHERE decision_id='review'")
      .first("status"),
  ).toBe("stale");
});
