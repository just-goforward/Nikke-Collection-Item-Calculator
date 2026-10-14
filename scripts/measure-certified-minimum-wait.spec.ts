import { describe, expect, it } from "vitest";
import {
  MINIMUM_WAIT_TIMING_CASES,
  minimumWaitTimingInput,
  summarizeMinimumWaitTimings,
} from "../src/certifiedRuntime/minimumWaitTiming";
import {
  measureChromiumMinimumWait,
  measureNodeMinimumWait,
} from "./measure-certified-minimum-wait";

describe("reproducible full-request timing inputs", () => {
  it("reports all five samples, their median and maximum without dropping failures", () => {
    const rows = MINIMUM_WAIT_TIMING_CASES.flatMap(({ id }) =>
      [3, 5, 1, 9, 7].map((elapsedMs) => ({
        id,
        elapsedMs,
        targetMet: elapsedMs !== 9,
        status: elapsedMs === 9 ? "partial" : "completed",
      })),
    );
    for (const summary of summarizeMinimumWaitTimings(rows))
      expect(summary).toMatchObject({
        samples: 5,
        medianMs: 5,
        maxMs: 9,
        withinBudget: 4,
        completed: 4,
      });
    expect(() => summarizeMinimumWaitTimings(rows.slice(1))).toThrow("requires_five_samples");
  });
  it("exposes both real-runtime harnesses without running benchmarks in the unit suite", () => {
    expect(typeof measureChromiumMinimumWait).toBe("function");
    expect(typeof measureNodeMinimumWait).toBe("function");
    expect(MINIMUM_WAIT_TIMING_CASES.map((fixture) => fixture.id)).toEqual([
      "R0",
      "R10",
      "R14",
      "SR5",
      "SR10",
      "SR13",
    ]);
  });
  it("uses v2, a whole recommendation and the seven research dispatch days plus normal shop", async () => {
    const input = await minimumWaitTimingInput("SR10");
    expect(input).toMatchObject({
      grade: "SR",
      level: 10,
      stock: [20, 10, 10],
      batchLimit: 10,
      computeMinimumWait: true,
      computeWaiting: true,
      snapshot: { version: "certified-daily-v2" },
    });
    const events = input.snapshot.events.filter(
      (event) => event.gameDate > "2026-10-13" && event.gameDate <= "2026-10-20",
    );
    expect(events.filter((event) => event.kind === "dispatch")).toHaveLength(7);
    expect(events.filter((event) => event.kind === "shop")).toMatchObject([
      {
        gameDate: "2026-10-20",
        refs: [{ lawId: "box-ii-v1", count: 5 }],
      },
    ]);
    expect(events.filter((event) => event.kind === "solo")).toHaveLength(0);
  });
});
