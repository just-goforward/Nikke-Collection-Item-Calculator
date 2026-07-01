import { describe, expect, it } from "vitest";

import type { StatsApiResponse } from "../schemas";
import { EMPTY_STATS_MESSAGE, statsViewFromApiStats } from "./statsView";

function statsWithEvents(events: number): StatsApiResponse {
  return {
    windowDays: 0,
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

  it("keeps cumulative statistics visible when the recent window is empty", () => {
    const stats = statsWithEvents(0);
    stats.cumulative = {
      summary: { events: 5, attempts: 8, greatSuccesses: 2, greatSuccessRate: 0.25 },
      byKit: [],
    };

    expect(statsViewFromApiStats(stats)).toEqual({ type: "stats", stats });
  });

  it("precomputes segment kit usage from level kit rows for rendering", () => {
    const stats = statsWithEvents(4);
    stats.segmentStats = [
      {
        key: "SR:10",
        label: "SR 10→15",
        events: 3,
        attempts: 3,
        greatSuccesses: 1,
        greatSuccessRate: 1 / 3,
        theoreticalGreatSuccessRate: 0.1,
        averageAttempts: 1,
      },
    ];
    stats.levelKitStats = [
      {
        grade: "SR",
        level: 10,
        kits: {
          blue: {
            attempts: 2,
            pieces: 20,
            greatSuccesses: 1,
            greatSuccessRate: 0.5,
            theoreticalGreatSuccessRate: 0.1,
          },
          purple: {
            attempts: 1,
            greatSuccesses: 0,
            greatSuccessRate: 0,
            theoreticalGreatSuccessRate: 0.2,
          },
          yellow: {
            attempts: 0,
            pieces: 0,
            greatSuccesses: 0,
            greatSuccessRate: 0,
            theoreticalGreatSuccessRate: 0.3,
          },
        },
      },
      {
        grade: "SR",
        level: 14,
        kits: {
          blue: {
            attempts: 1,
            pieces: 10,
            greatSuccesses: 0,
            greatSuccessRate: 0,
            theoreticalGreatSuccessRate: 0.1,
          },
          purple: {
            attempts: 2,
            pieces: 20,
            greatSuccesses: 1,
            greatSuccessRate: 0.5,
            theoreticalGreatSuccessRate: 0.2,
          },
          yellow: {
            attempts: 3,
            pieces: 30,
            greatSuccesses: 0,
            greatSuccessRate: 0,
            theoreticalGreatSuccessRate: 0.3,
          },
        },
      },
    ];

    const view = statsViewFromApiStats(stats);

    expect(view).toMatchObject({
      type: "stats",
      stats: {
        segmentStats: [
          {
            byKit: [
              { kit: "blue", attempts: 3, pieces: 30 },
              { kit: "purple", attempts: 3, pieces: 30 },
              { kit: "yellow", attempts: 3, pieces: 30 },
            ],
          },
        ],
      },
    });
    if (view.type !== "stats") throw new Error("Expected stats view.");
    expect(view.stats.segmentStats?.[0]?.byKit?.[0]?.theoreticalGreatSuccessRate).toBeCloseTo(0.1);
    expect(view.stats.segmentStats?.[0]?.byKit?.[1]?.theoreticalGreatSuccessRate).toBeCloseTo(0.2);
    expect(view.stats.segmentStats?.[0]?.byKit?.[2]?.theoreticalGreatSuccessRate).toBeCloseTo(0.3);
  });
});
