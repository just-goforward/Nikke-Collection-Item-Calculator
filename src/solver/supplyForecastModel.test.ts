import { describe, expect, it } from "vitest";

import {
  buildScheduleForecastProfiles,
  DISPATCH_COHORT_EXPECTED_GAIN,
  DISPATCH_DAILY_EXPECTED_GAIN,
  enumerateDispatchExpectedGain,
  gameDayKey,
  SOLO_REMAINING_GAIN,
} from "../../shared/supplyForecastModel";

describe("schedule supply forecast model", () => {
  it("reproduces the exact dispatch policy cohorts and equal mixture", () => {
    expect(enumerateDispatchExpectedGain(0)).toEqual(DISPATCH_COHORT_EXPECTED_GAIN.noReroll);
    expect(enumerateDispatchExpectedGain(1)).toEqual(DISPATCH_COHORT_EXPECTED_GAIN.oneReroll);
    expect(enumerateDispatchExpectedGain(2)).toEqual(DISPATCH_COHORT_EXPECTED_GAIN.twoRerolls);
    expect(DISPATCH_DAILY_EXPECTED_GAIN.blue).toBeCloseTo(8.947399682, 9);
    expect(DISPATCH_DAILY_EXPECTED_GAIN.purple).toBeCloseTo(2.014546824, 9);
    expect(DISPATCH_DAILY_EXPECTED_GAIN.yellow).toBeCloseTo(0.71420816, 9);
  });

  it("uses 05:00 KST as the game-day boundary", () => {
    expect(gameDayKey(Date.parse("2026-09-01T04:59:59+09:00"))).toBe("2026-08-31");
    expect(gameDayKey(Date.parse("2026-09-01T05:00:00+09:00"))).toBe("2026-09-01");
  });

  it("removes solo rewards after each eligible game day and stays monotonic", () => {
    const profiles = buildScheduleForecastProfiles({
      forecastId: "supply-2026-08-23-v1",
      effectiveFrom: "2026-08-23T05:00:00+09:00",
      nextSoloStart: "2026-09-17T12:00:00+09:00",
      scheduleStatus: "confirmed",
      collaborationPeriods: [],
    });
    const at = (timestamp: string) => {
      const value = Date.parse(timestamp);
      const profile = profiles.find(
        (entry) =>
          value >= Date.parse(entry.effectiveFrom) &&
          value <
            (entry.effectiveUntil === null
              ? Number.POSITIVE_INFINITY
              : Date.parse(entry.effectiveUntil)),
      );
      if (!profile) throw new Error(`Missing profile for ${timestamp}`);
      return profile.expectedGain;
    };
    const before = at("2026-09-17T11:59:59+09:00");
    const day1 = at("2026-09-17T12:00:00+09:00");
    const day2 = at("2026-09-18T05:00:00+09:00");
    const day3 = at("2026-09-19T05:00:00+09:00");
    expect(before.blue - day1.blue).toBeCloseTo(
      SOLO_REMAINING_GAIN.beforeStart.blue - SOLO_REMAINING_GAIN.afterDay1.blue,
      9,
    );
    expect(day1.blue - day2.blue).toBeGreaterThan(
      SOLO_REMAINING_GAIN.afterDay1.blue - SOLO_REMAINING_GAIN.afterDay2.blue,
    );
    expect(day2.blue - day3.blue).toBeGreaterThan(
      SOLO_REMAINING_GAIN.afterDay2.blue - SOLO_REMAINING_GAIN.afterDay3.blue,
    );
    for (let index = 1; index < profiles.length; index += 1) {
      const previous = profiles[index - 1]?.expectedGain;
      const current = profiles[index]?.expectedGain;
      expect(current?.blue).toBeLessThanOrEqual(previous?.blue ?? Number.POSITIVE_INFINITY);
      expect(current?.purple).toBeLessThanOrEqual(previous?.purple ?? Number.POSITIVE_INFINITY);
      expect(current?.yellow).toBeLessThanOrEqual(previous?.yellow ?? Number.POSITIVE_INFINITY);
    }
  });

  it("doubles Tuesday co-op boxes only inside a collaboration period", () => {
    const base = {
      forecastId: "supply-2026-08-23-v1",
      effectiveFrom: "2026-08-23T05:00:00+09:00",
      nextSoloStart: "2026-09-17T12:00:00+09:00",
      scheduleStatus: "confirmed" as const,
    };
    const normal = buildScheduleForecastProfiles({ ...base, collaborationPeriods: [] });
    const collaboration = buildScheduleForecastProfiles({
      ...base,
      collaborationPeriods: [
        {
          effectiveFrom: "2026-08-24T05:00:00+09:00",
          effectiveUntil: "2026-08-26T05:00:00+09:00",
        },
      ],
    });
    expect(collaboration[0]?.expectedGain.blue).toBeCloseTo(
      (normal[0]?.expectedGain.blue ?? 0) + 17.5,
      9,
    );
    expect(collaboration[0]?.expectedGain.purple).toBeCloseTo(
      (normal[0]?.expectedGain.purple ?? 0) + 2,
      9,
    );
    expect(collaboration[0]?.expectedGain.yellow).toBeCloseTo(
      (normal[0]?.expectedGain.yellow ?? 0) + 1,
      9,
    );
  });
});
