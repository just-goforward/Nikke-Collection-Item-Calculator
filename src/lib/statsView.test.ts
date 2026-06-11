import { describe, expect, it } from "vitest";

import type { StatsApiResponse } from "../schemas";
import { EMPTY_STATS_MESSAGE, statsViewFromApiStats } from "./statsView";

function statsWithEvents(events: number): StatsApiResponse {
  return {
    windowDays: 30,
    today: "2026-06-11",
    summary: {
      events,
      attempts: events * 2,
      greatSuccesses: events,
      greatSuccessRate: events > 0 ? 0.5 : 0,
      todayEvents: 0,
      todayAttempts: 0,
      todayGreatSuccesses: 0,
      mostUsedKit: null,
      mostUsedKitPieces: 0,
    },
    byKit: [],
    levelKitStats: [],
    segmentStats: [],
    successAttemptDistribution: [],
  };
}

describe("statsViewFromApiStats", () => {
  it("returns an empty view when the aggregate has no events", () => {
    expect(statsViewFromApiStats(statsWithEvents(0))).toEqual({
      type: "empty",
      message: EMPTY_STATS_MESSAGE,
    });
  });

  it("returns a stats view with the validated payload when events exist", () => {
    const stats = statsWithEvents(3);

    expect(statsViewFromApiStats(stats)).toEqual({ type: "stats", stats });
  });
});
