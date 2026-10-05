import { describe, expect, it } from "vitest";
import { add, fromWire, q, toNumber } from "./certifiedRational.ts";
import {
  assertCertifiedSupplySnapshot,
  buildCertifiedSupplySnapshot,
  certifiedRecurringRate,
  compareCertifiedSupplyPeriods,
  deriveCertifiedDailySupply,
  viewCertifiedSupplySnapshot,
} from "./certifiedSupply.ts";
import {
  deriveExactSoloRaidCadence,
  estimateCertifiedSoloRounds,
  SOLO_RAID_ROUND_HISTORY,
} from "./soloRaidCadence.ts";
import {
  buildScheduleForecastProfiles,
  gameDayStartCeilMs,
  gameDayStartMs,
} from "./supplyForecastModel.ts";

const cadence = deriveExactSoloRaidCadence();
const base = {
  asOf: "2026-09-30T12:00:00+09:00",
  revision: "test-v1",
  sourceHash: "a".repeat(64),
  soloPeriods: [],
  collaborationPeriods: [],
  sourceStatus: "uncertain" as const,
};

describe("certified daily supply contract", () => {
  it("keeps the exact observed mean and independently snaps each estimate", () => {
    expect(cadence).toMatchObject({
      numerator: 1197,
      denominator: 39,
      rounds: 40,
      intervals: 39,
      fromGameDate: "2023-05-11",
      untilGameDate: "2026-08-20",
    });
    const rounds = estimateCertifiedSoloRounds({
      anchor: SOLO_RAID_ROUND_HISTORY[39]!,
      cadence,
      count: 3,
    });
    expect(rounds.map((r) => r.startGameDate)).toEqual(["2026-09-17", "2026-10-22", "2026-11-19"]);
    expect(rounds.map((r) => r.round)).toEqual([41, 42, 43]);
  });
  it("records missing history and excludes ongoing unverified residual rewards", () => {
    const snapshot = buildCertifiedSupplySnapshot({ ...base, asOf: "2026-09-20T12:00:00+09:00" });
    expect(snapshot.soloRounds.find((r) => r.round === 41)?.status).toBe("unverified");
    expect(snapshot.events.some((e) => e.id.startsWith("solo:r41:"))).toBe(false);
    expect(snapshot.coverage.past.missing).toContain("raid_durations");
    const daily = deriveCertifiedDailySupply(snapshot);
    expect(daily.filter((d) => d.offset >= 1 && d.offset <= 56)).toHaveLength(56);
    expect(daily.filter((d) => d.offset >= -56 && d.offset <= -1)).toHaveLength(56);
    expect(daily.filter((d) => d.offset === 0)).toHaveLength(1);
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });
  it("delays the same round and all subsequent estimates only with healthy sources", () => {
    const snapshot = buildCertifiedSupplySnapshot({ ...base, sourceStatus: "healthy" });
    expect(snapshot.soloRounds.find((r) => r.round === 41)?.startGameDate).toBe("2026-10-01");
    expect(snapshot.soloRounds.find((r) => r.round === 42)?.startGameDate).toBe("2026-11-05");
    expect(snapshot.delayState.offsetDays).toBe(14);
    const later = buildCertifiedSupplySnapshot({
      ...base,
      asOf: "2026-10-02T12:00:00+09:00",
      sourceStatus: "healthy",
      delayState: snapshot.delayState,
    });
    expect(later.soloRounds.find((r) => r.round === 41)?.startGameDate).toBe("2026-10-08");
    expect(later.delayState.offsetDays).toBe(21);
  });
  it("uses current per-round rewards and the exact mean in recurring prices", () => {
    const snapshot = buildCertifiedSupplySnapshot({
      ...base,
      historyCoverage: {
        from: "2026-08-01T05:00:00+09:00",
        until: "2026-09-30T05:00:00+09:00",
        raidDurations: false,
        collaborationPeriods: true,
        rewardRules: true,
      },
    });
    const rates = certifiedRecurringRate(snapshot);
    expect(rates.map(toNumber)).toEqual(
      expect.arrayContaining([
        expect.closeTo(20.452913466875, 8),
        expect.closeTo(3.290737299774, 8),
        expect.closeTo(1.300173072026, 8),
      ]),
    );
    const comparison = compareCertifiedSupplyPeriods(snapshot);
    expect(comparison.past.days).toBe(56);
    expect(comparison.future.days).toBe(56);
    expect(comparison.past.shopDays).toBe(8);
    expect(comparison.future.shopDays).toBe(8);
    expect(comparison.partial).toBe(true);
    expect(comparison.past.missing).toContain("raid_durations");
  });
  it("reanchors official announcements and keeps round/day identities", () => {
    const delayed = buildCertifiedSupplySnapshot({ ...base, sourceStatus: "healthy" });
    const official = buildCertifiedSupplySnapshot({
      ...base,
      sourceStatus: "healthy",
      delayState: delayed.delayState,
      soloPeriods: [
        {
          round: 41,
          effectiveFrom: "2026-10-08T05:00:00+09:00",
          effectiveUntil: "2026-10-15T05:00:00+09:00",
          scheduleStatus: "confirmed",
        },
      ],
    });
    expect(official.delayState).toEqual({
      anchorRound: 41,
      anchorGameDate: "2026-10-08",
      offsetDays: 0,
    });
    expect(delayed.events.find((event) => event.id === "solo:r41:day1")?.status).toBe("estimated");
    expect(official.events.find((event) => event.id === "solo:r41:day1")?.status).toBe("confirmed");
    expect(official.soloRounds.find((round) => round.round === 42)?.startGameDate).toBe(
      "2026-11-05",
    );
  });
  it("preserves official intraday availability and explicit period expiry", () => {
    const snapshot = buildCertifiedSupplySnapshot({
      ...base,
      asOf: "2026-08-20T08:00:00+09:00",
      soloPeriods: [
        {
          round: 40,
          effectiveFrom: "2026-08-20T03:00:00.000Z",
          effectiveUntil: "2026-08-26T19:59:00.000Z",
          scheduleStatus: "confirmed",
        },
      ],
    });
    const first = snapshot.events.find((event) => event.id === "solo:r40:day1");
    expect(first?.gameDate).toBe("2026-08-20");
    expect(first?.at).toBe("2026-08-20T03:00:00.000Z");
    expect(first?.expiresAt).toBe("2026-08-26T19:59:00.000Z");
    expect(deriveCertifiedDailySupply(snapshot).find((day) => day.offset === 0)?.events).toContain(
      first,
    );
  });
  it("views adopted authority without silently extending it", () => {
    const accepted = buildCertifiedSupplySnapshot({ ...base, horizonDays: 112 });
    const next = viewCertifiedSupplySnapshot(accepted, "2026-10-01T12:00:00+09:00");
    expect(next.coverage.from).toBe(accepted.coverage.from);
    expect(next.coverage.until).toBe(accepted.coverage.until);
    expect(next.events).toBe(accepted.events);
    expect(next.sourceHash).toBe(accepted.sourceHash);
    expect(compareCertifiedSupplyPeriods(next).future.days).toBe(56);
    expect(next.coverage.past.missing).not.toContain("authority_coverage");
    const earlier = viewCertifiedSupplySnapshot(accepted, "2026-09-29T12:00:00+09:00");
    expect(earlier.coverage.past.missing).toContain("authority_coverage");
    const late = viewCertifiedSupplySnapshot(accepted, "2027-03-01T12:00:00+09:00");
    expect(late.coverage.future.complete).toBe(false);
    expect(late.coverage.future.missing).toContain("authority_coverage");
    expect(assertCertifiedSupplySnapshot(JSON.parse(JSON.stringify(next))).revision).toBe(
      base.revision,
    );
  });
  it("rejects malformed serialized authority and reports past zero as N/A", () => {
    const snapshot = buildCertifiedSupplySnapshot(base);
    expect(compareCertifiedSupplyPeriods(snapshot).percentChange).toEqual([null, null, null]);
    const duplicate = JSON.parse(JSON.stringify(snapshot));
    duplicate.events.push(duplicate.events[0]);
    expect(() => assertCertifiedSupplySnapshot(duplicate)).toThrow("identity");
    const invalid = JSON.parse(JSON.stringify(snapshot));
    invalid.cadence.numerator += 1;
    expect(() => assertCertifiedSupplySnapshot(invalid)).toThrow("cadence_period");
  });
  it("excludes residual rewards when an adopted future estimate becomes unverified", () => {
    const accepted = buildCertifiedSupplySnapshot({
      ...base,
      asOf: "2026-09-10T12:00:00+09:00",
      horizonDays: 112,
    });
    expect(accepted.events.some((event) => event.id === "solo:r41:day5")).toBe(true);
    const view = viewCertifiedSupplySnapshot(accepted, "2026-09-20T12:00:00+09:00");
    expect(view.soloRounds.find((round) => round.round === 41)?.status).toBe("unverified");
    expect(
      deriveCertifiedDailySupply(view).some((day) =>
        day.events.some((event) => event.id.startsWith("solo:r41:")),
      ),
    ).toBe(false);
    expect(view.warnings).toContain("ongoing_unverified_round_excluded");
    expect(view.coverage.future.complete).toBe(true);
  });
});

describe("certified supply legacy reference parity", () => {
  it("reproduces every legacy reference window from exact derived daily expectations", () => {
    const periods = [
      {
        round: 40,
        effectiveFrom: "2026-08-20T05:00:00+09:00",
        effectiveUntil: "2026-08-27T05:00:00+09:00",
        scheduleStatus: "confirmed" as const,
      },
      {
        round: 41,
        effectiveFrom: "2026-09-17T05:00:00+09:00",
        effectiveUntil: "2026-09-24T05:00:00+09:00",
        scheduleStatus: "confirmed" as const,
      },
      {
        round: 42,
        effectiveFrom: "2026-10-22T05:00:00+09:00",
        effectiveUntil: "2026-10-29T05:00:00+09:00",
        scheduleStatus: "confirmed" as const,
      },
      {
        round: 43,
        effectiveFrom: "2026-11-19T05:00:00+09:00",
        effectiveUntil: "2026-11-26T05:00:00+09:00",
        scheduleStatus: "confirmed" as const,
      },
    ];
    const collaborationPeriods = [
      { effectiveFrom: "2026-09-08T05:00:00+09:00", effectiveUntil: "2026-09-23T05:00:00+09:00" },
    ];
    const accepted = buildCertifiedSupplySnapshot({
      ...base,
      asOf: "2026-09-01T05:00:00+09:00",
      horizonDays: 112,
      soloPeriods: periods,
      collaborationPeriods,
      historyCoverage: {
        from: "2026-07-01T05:00:00+09:00",
        until: "2026-09-01T05:00:00+09:00",
        raidDurations: true,
        collaborationPeriods: true,
        rewardRules: true,
      },
    });
    const profiles = buildScheduleForecastProfiles({
      forecastId: "supply-2026-09-01-v1",
      effectiveFrom: "2026-09-01T05:00:00+09:00",
      soloPeriods: periods,
      collaborationPeriods,
    });
    const dayMs = 86_400_000;
    for (const profile of profiles) {
      const at = Date.parse(profile.effectiveFrom);
      const currentDay = gameDayStartMs(at);
      const activeIndex = periods.findIndex(
        (period) =>
          at >= gameDayStartMs(Date.parse(period.effectiveFrom)) &&
          at < gameDayStartCeilMs(Date.parse(period.effectiveUntil)),
      );
      let from = currentDay;
      let until: number;
      if (activeIndex >= 0) {
        const active = periods[activeIndex]!;
        const dayNumber =
          Math.floor((currentDay - gameDayStartMs(Date.parse(active.effectiveFrom))) / dayMs) + 1;
        if (dayNumber <= 2) {
          from = gameDayStartMs(Date.parse(periods[activeIndex - 1]!.effectiveFrom)) + 2 * dayMs;
          until = currentDay;
        } else until = gameDayStartMs(Date.parse(periods[activeIndex + 1]!.effectiveFrom)) + dayMs;
      } else
        until =
          gameDayStartMs(
            Date.parse(
              periods.find((period) => gameDayStartMs(Date.parse(period.effectiveFrom)) > at)!
                .effectiveFrom,
            ),
          ) + dayMs;
      const daily = deriveCertifiedDailySupply(
        viewCertifiedSupplySnapshot(accepted, profile.effectiveFrom),
      ).filter((day) => Date.parse(day.at) >= from && Date.parse(day.at) <= until);
      const gain = [q(0), q(0), q(0)];
      for (const day of daily)
        for (const k of [0, 1, 2] as const) gain[k] = add(gain[k]!, fromWire(day.expectedGain[k]));
      expect(gain.map((value) => Number(toNumber(value).toFixed(9)))).toEqual([
        profile.expectedGain.blue,
        profile.expectedGain.purple,
        profile.expectedGain.yellow,
      ]);
    }
  });
});
