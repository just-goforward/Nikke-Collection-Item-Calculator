import { describe, expect, it } from "vitest";
import { add, mul, q, toNumber, ZERO } from "../../shared/certifiedRational";
import {
  buildCertifiedSupplySnapshot,
  certifiedCohortWeights,
  expectedCertifiedRefs,
} from "../../shared/certifiedSupply";
import { GAME_DAY_MS } from "../../shared/gameDay";
import {
  assertLedgerForecastProfiles,
  buildScheduleForecastProfiles,
  projectSupplyAt,
  supplyReferenceWindow,
} from "../../shared/supplyForecastProjection";

const at = (date: string) => Date.parse(`${date}T05:00:00+09:00`);
const snapshot = buildCertifiedSupplySnapshot({
  // Preserve the v3 ledger projection oracle, independently of the current UI policy.
  version: "certified-daily-v3",
  asOf: new Date(at("2026-09-16")).toISOString(),
  revision: "reference-windows",
  sourceHash: "b".repeat(64),
  horizonDays: 112,
  collaborationPeriods: [],
  soloPeriods: [
    [40, "2026-08-20", "2026-08-27"],
    [41, "2026-09-17", "2026-09-24"],
    [42, "2026-10-15", "2026-10-22"],
    [43, "2026-11-12", "2026-11-19"],
  ].map(([round, start, end]) => ({
    round: Number(round),
    effectiveFrom: `${start}T12:00:00+09:00`,
    effectiveUntil: `${end}T04:59:00+09:00`,
    scheduleStatus: "confirmed" as const,
  })),
});
const input = {
  forecastId: "supply-2026-09-16-v3",
  effectiveFrom: snapshot.asOf,
  certifiedSnapshot: snapshot,
};

describe("ledger-only legacy supply projection", () => {
  it("keeps half-open Solo day 1/2 windows but refuses their missing historical portion", () => {
    expect(supplyReferenceWindow(snapshot, at("2026-09-17"))).toMatchObject({
      from: at("2026-08-22"),
      until: at("2026-09-18"),
    });
    expect(supplyReferenceWindow(snapshot, at("2026-09-18"))).toMatchObject({
      from: at("2026-08-22"),
      until: at("2026-09-19"),
    });
    expect(projectSupplyAt(snapshot, at("2026-09-17"))).toEqual({
      available: false,
      reason: "authority_coverage",
    });
    const profiles = buildScheduleForecastProfiles(input);
    expect(
      profiles.some(
        (profile) => profile.effectiveFrom === new Date(at("2026-09-17")).toISOString(),
      ),
    ).toBe(false);
  });

  it("sums day 3 through next Solo day 2 with four Tuesdays and four Wednesdays", () => {
    const result = projectSupplyAt(snapshot, at("2026-09-19"));
    if (!result.available) throw new Error(result.reason);
    expect(result.window).toMatchObject({ from: at("2026-09-19"), until: at("2026-10-17") });
    const dispatch = expectedCertifiedRefs(
      [{ lawId: "dispatch-board-v1", count: 1 }],
      certifiedCohortWeights(undefined, snapshot.version),
      {},
    );
    const expected = dispatch.map((daily, color) =>
      add(mul(daily, q(28)), [q(1932, 5), q(392, 5), q(88, 5)][color] ?? ZERO),
    );
    expect(result.expected).toEqual(expected);
    expect(result.expected.map(toNumber)).toEqual([
      expect.closeTo(646.742308824498, 10),
      expect.closeTo(143.150978799701, 10),
      expect.closeTo(40.882123179654, 10),
    ]);
  });

  it("uses reset boundaries, finite profiles, explicit duration and exactly checked projections", () => {
    const profiles = buildScheduleForecastProfiles(input);
    expect(profiles.length).toBeGreaterThan(0);
    for (const profile of profiles) {
      expect(profile.effectiveUntil).not.toBeNull();
      expect(profile.referenceDays).toBe(
        (Date.parse(profile.referenceUntil ?? "") - Date.parse(profile.referenceFrom ?? "")) /
          GAME_DAY_MS,
      );
    }
    expect(() => assertLedgerForecastProfiles(input.forecastId, snapshot, profiles)).not.toThrow();
    const first = profiles[0];
    if (!first) throw new Error("fixture_profile");
    expect(() =>
      assertLedgerForecastProfiles(input.forecastId, snapshot, [
        { ...first, expectedGain: { ...first.expectedGain, blue: first.expectedGain.blue + 1 } },
        ...profiles.slice(1),
      ]),
    ).toThrow("forecast_profiles_do_not_match_ledger");
    expect(projectSupplyAt(snapshot, Date.parse("2026-09-19T04:59:59+09:00")).available).toBe(
      false,
    );
    expect(projectSupplyAt(snapshot, at("2026-09-19")).available).toBe(true);
    expect(() =>
      buildScheduleForecastProfiles({ forecastId: input.forecastId, effectiveFrom: snapshot.asOf }),
    ).toThrow("certified_snapshot_required");
  });
});
