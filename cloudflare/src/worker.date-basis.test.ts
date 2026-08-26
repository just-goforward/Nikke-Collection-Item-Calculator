import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kitResultEvent, solverDiagnosticEvent } from "./worker.test-events";
import { WorkerTestHarness } from "./worker.test-harness";
import type { AdminDiagnosticsBody } from "./worker.test-types";

const harness = new WorkerTestHarness();

beforeEach(async () => {
  await harness.setup();
});

afterEach(async () => {
  await harness.teardown();
});

describe("statistics date-basis transition", () => {
  it("assigns new events to the prior game date until 04:59:59 KST", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(Date.parse("2026-08-26T04:59:59+09:00"));
      expect((await harness.submit(kitResultEvent("kit-result-before-0500"))).status).toBe(200);

      nowSpy.mockReturnValue(Date.parse("2026-08-26T05:00:00+09:00"));
      expect((await harness.submit(kitResultEvent("kit-result-after-05000"))).status).toBe(200);

      const rows = await harness.database
        .prepare(
          "SELECT date_key, SUM(events) AS events FROM event_aggregates_game_day GROUP BY date_key ORDER BY date_key",
        )
        .all<{ date_key: string; events: number }>();
      expect(rows.results).toEqual([
        { date_key: "2026-08-25", events: 1 },
        { date_key: "2026-08-26", events: 1 },
      ]);
      await expect(harness.countRows("event_aggregates")).resolves.toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("combines legacy history but uses only game-day rows for today's counters", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-26T04:59:59+09:00"));
    try {
      await insertPublicAggregates();

      const response = await harness.fetchStats();
      const body = (await response.json()) as {
        dateContract?: unknown;
        summary?: {
          events?: number;
          attempts?: number;
          todayEvents?: number;
          todayAttempts?: number;
        };
      };

      expect(body.summary).toMatchObject({
        events: 5,
        attempts: 9,
        todayEvents: 3,
        todayAttempts: 5,
      });
      expect(body.dateContract).toEqual({
        legacy: {
          id: "kst_calendar_date_v1",
          boundary: "00:00:00+09:00",
          acceptsNewWrites: false,
        },
        current: {
          id: "kst_game_day_0500_v2",
          boundary: "05:00:00+09:00",
          acceptsNewWrites: true,
        },
        cumulativeIncludes: ["kst_calendar_date_v1", "kst_game_day_0500_v2"],
        todayBasis: "kst_game_day_0500_v2",
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps legacy and 05:00 diagnostics visibly separate", async () => {
    expect((await harness.submit(solverDiagnosticEvent("solver-admin-basis-0001"))).status).toBe(
      200,
    );
    await harness.database
      .prepare(
        `INSERT INTO solver_diagnostic_aggregates
         SELECT * FROM solver_diagnostic_aggregates_game_day`,
      )
      .run();

    const response = await harness.fetchAdminSolverDiagnostics();
    const body = (await response.json()) as AdminDiagnosticsBody;
    const matching = body.allTime?.filter((row) => row.solverVersion === "phase1") ?? [];

    expect(body.dateContract).toEqual({
      legacy: {
        id: "kst_calendar_date_v1",
        boundary: "00:00:00+09:00",
        acceptsNewWrites: false,
      },
      current: {
        id: "kst_game_day_0500_v2",
        boundary: "05:00:00+09:00",
        acceptsNewWrites: true,
      },
      rowsExposeDateBasis: true,
    });
    expect(matching).toHaveLength(2);
    expect(new Set(matching.map((row) => row.dateBasis))).toEqual(
      new Set(["kst_calendar_date_v1", "kst_game_day_0500_v2"]),
    );
  });
});

async function insertPublicAggregates() {
  await harness.database.batch([
    harness.database
      .prepare(
        `INSERT INTO event_aggregates
         (date_key, grade, level, exp_bucket, kit, recommended_uses, outcome, success_attempt,
          events, attempts, great_successes, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("2026-08-25", "R", 0, 50, "blue", 1, "great", 1, 2, 4, 1, 1_800_000_000),
    harness.database
      .prepare(
        `INSERT INTO event_aggregates_game_day
         (date_key, grade, level, exp_bucket, kit, recommended_uses, outcome, success_attempt,
          events, attempts, great_successes, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("2026-08-25", "R", 0, 50, "blue", 1, "great", 1, 3, 5, 1, 1_800_000_000),
  ]);
}
