import { describe, expect, it } from "vitest";

import {
  buildScheduleForecastProfiles,
  DISPATCH_COHORT_EXPECTED_GAIN,
  DISPATCH_DAILY_EXPECTED_GAIN,
  enumerateDispatchExpectedGain,
  gameDayKey,
  SOLO_DAILY_EXPECTED_GAIN,
  YELLOW_BOX_GAIN,
} from "../../shared/supplyForecastModel";

const soloPeriods = [
  solo("2026-08-20T12:00:00+09:00", "2026-08-27T04:59:00+09:00", "confirmed"),
  solo("2026-09-17T12:00:00+09:00", "2026-09-24T04:59:00+09:00", "confirmed"),
  solo("2026-10-15T12:00:00+09:00", "2026-10-22T04:59:00+09:00", "estimated"),
  solo("2026-11-12T12:00:00+09:00", "2026-11-19T04:59:00+09:00", "estimated"),
] as const;

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

  it("accumulates from the previous day 3 on Solo days 1 and 2", () => {
    const profiles = profilesFor();
    const day1AtReset = at(profiles, "2026-09-17T05:00:00+09:00");
    const day1 = at(profiles, "2026-09-17T12:00:00+09:00");
    const day2 = at(profiles, "2026-09-18T05:00:00+09:00");
    const previousLate = scale(SOLO_DAILY_EXPECTED_GAIN.day3AndLater, 5);
    const fixedWeeklyCoop = scale(YELLOW_BOX_GAIN, 20);

    expect(day1).toEqual(
      rounded(
        add(
          scale(DISPATCH_DAILY_EXPECTED_GAIN, 27),
          previousLate,
          SOLO_DAILY_EXPECTED_GAIN.day1,
          fixedWeeklyCoop,
        ),
      ),
    );
    expect(day1AtReset).toEqual(day1);
    expect(profiles.some((profile) => profile.effectiveFrom === "2026-09-17T03:00:00.000Z")).toBe(
      false,
    );
    expect(day2).toEqual(
      rounded(
        add(
          scale(DISPATCH_DAILY_EXPECTED_GAIN, 28),
          previousLate,
          SOLO_DAILY_EXPECTED_GAIN.day1,
          SOLO_DAILY_EXPECTED_GAIN.day2,
          fixedWeeklyCoop,
        ),
      ),
    );
    expect(day2.blue).toBeGreaterThan(day1.blue);
  });

  it("switches on day 3 to current remainder plus the next Solo day 2", () => {
    const profiles = profilesFor();
    const day3 = at(profiles, "2026-09-19T05:00:00+09:00");
    const day4 = at(profiles, "2026-09-20T05:00:00+09:00");
    const afterEnd = at(profiles, "2026-09-24T05:00:00+09:00");
    const nextOpening = add(SOLO_DAILY_EXPECTED_GAIN.day1, SOLO_DAILY_EXPECTED_GAIN.day2);
    const fourWeeklyCoopResets = scale(YELLOW_BOX_GAIN, 20);
    const threeWeeklyCoopResets = scale(YELLOW_BOX_GAIN, 15);

    expect(day3).toEqual(
      rounded(
        add(
          scale(DISPATCH_DAILY_EXPECTED_GAIN, 28),
          scale(SOLO_DAILY_EXPECTED_GAIN.day3AndLater, 5),
          nextOpening,
          fourWeeklyCoopResets,
        ),
      ),
    );
    expect(day4).toEqual(
      rounded(
        add(
          scale(DISPATCH_DAILY_EXPECTED_GAIN, 27),
          scale(SOLO_DAILY_EXPECTED_GAIN.day3AndLater, 4),
          nextOpening,
          fourWeeklyCoopResets,
        ),
      ),
    );
    expect(afterEnd).toEqual(
      rounded(add(scale(DISPATCH_DAILY_EXPECTED_GAIN, 23), nextOpening, threeWeeklyCoopResets)),
    );
    expect(day4.blue).toBeLessThan(day3.blue);
    expect(afterEnd.blue).toBeLessThan(day4.blue);
  });

  it("always includes weekly Tuesday supply and doubles only announced collaboration Tuesdays", () => {
    const regular = profilesFor();
    const collaboration = profilesFor([
      {
        effectiveFrom: "2026-09-14T05:00:00+09:00",
        effectiveUntil: "2026-09-16T05:00:00+09:00",
      },
    ]);
    const regularDay1 = at(regular, "2026-09-17T12:00:00+09:00");
    const collaborationDay1 = at(collaboration, "2026-09-17T12:00:00+09:00");

    expect(collaborationDay1).toEqual(rounded(add(regularDay1, scale(YELLOW_BOX_GAIN, 5))));
  });

  it("changes the active profile at 05:00 KST, not at 04:59", () => {
    const profiles = profilesFor();
    const beforeReset = at(profiles, "2026-09-18T04:59:59+09:00");
    const afterReset = at(profiles, "2026-09-18T05:00:00+09:00");

    expect(beforeReset).toEqual(at(profiles, "2026-09-17T12:00:00+09:00"));
    expect(afterReset).toEqual(at(profiles, "2026-09-18T12:00:00+09:00"));
    expect(afterReset).not.toEqual(beforeReset);
  });
});

function profilesFor(
  collaborationPeriods: Parameters<
    typeof buildScheduleForecastProfiles
  >[0]["collaborationPeriods"] = [],
) {
  return buildScheduleForecastProfiles({
    forecastId: "supply-2026-09-17-v1",
    effectiveFrom: "2026-09-17T05:00:00+09:00",
    soloPeriods,
    collaborationPeriods,
  });
}

function at(profiles: ReturnType<typeof profilesFor>, timestamp: string) {
  const value = Date.parse(timestamp);
  const profile = profiles.find((entry) => {
    const until =
      entry.effectiveUntil === null ? Number.POSITIVE_INFINITY : Date.parse(entry.effectiveUntil);
    return value >= Date.parse(entry.effectiveFrom) && value < until;
  });
  if (!profile) throw new Error(`Missing profile for ${timestamp}`);
  return profile.expectedGain;
}

function solo(
  effectiveFrom: string,
  effectiveUntil: string,
  scheduleStatus: "confirmed" | "estimated",
) {
  return { effectiveFrom, effectiveUntil, scheduleStatus };
}

function add(...values: readonly { blue: number; purple: number; yellow: number }[]) {
  return values.reduce(
    (sum, value) => ({
      blue: sum.blue + value.blue,
      purple: sum.purple + value.purple,
      yellow: sum.yellow + value.yellow,
    }),
    { blue: 0, purple: 0, yellow: 0 },
  );
}

function scale(value: { blue: number; purple: number; yellow: number }, factor: number) {
  return {
    blue: value.blue * factor,
    purple: value.purple * factor,
    yellow: value.yellow * factor,
  };
}

function rounded(value: { blue: number; purple: number; yellow: number }) {
  return {
    blue: Number(value.blue.toFixed(9)),
    purple: Number(value.purple.toFixed(9)),
    yellow: Number(value.yellow.toFixed(9)),
  };
}
