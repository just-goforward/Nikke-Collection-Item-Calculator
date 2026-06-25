import { describe, expect, it } from "vitest";

import { StatsApiResponseSchema } from "./schemas";

const baseResponse = {
  windowDays: 0,
  today: "2026-05-26",
  summary: {
    events: 0,
    attempts: 0,
    greatSuccesses: 0,
    greatSuccessRate: 0,
    todayEvents: 0,
    todayAttempts: 0,
    todayGreatSuccesses: 0,
    mostUsedKit: null,
    mostUsedKitPieces: 0,
  },
  byKit: [],
  cumulative: {
    summary: { events: 0, attempts: 0, greatSuccesses: 0, greatSuccessRate: 0 },
    byKit: [],
  },
  segmentStats: [],
};

describe("StatsApiResponseSchema", () => {
  it("defaults removed legacy statistics arrays when a compatible worker omits them", () => {
    const parsed = StatsApiResponseSchema.parse(baseResponse);

    expect(parsed.levelKitStats).toEqual([]);
    expect(parsed.successAttemptDistribution).toEqual([]);
  });

  it("accepts compatibility placeholders from the worker", () => {
    const parsed = StatsApiResponseSchema.parse({
      ...baseResponse,
      levelKitStats: [],
      successAttemptDistribution: [],
    });

    expect(parsed.levelKitStats).toEqual([]);
    expect(parsed.successAttemptDistribution).toEqual([]);
  });
});
