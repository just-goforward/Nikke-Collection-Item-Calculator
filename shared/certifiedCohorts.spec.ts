import { describe, expect, it } from "vitest";
import { q, toNumber, toWire } from "./certifiedRational.ts";
import {
  assertCertifiedSupplySnapshot,
  buildCertifiedSupplySnapshot,
  certifiedCohortWeights,
  certifiedRecurringRate,
  DEFAULT_PERSONAL_COHORT_WEIGHTS,
} from "./certifiedSupply.ts";
import {
  type CertifiedSupplyLaw,
  getCertifiedLawDistribution,
  LEGACY_CERTIFIED_SUPPLY_LAWS,
} from "./certifiedSupplyLaws.ts";

const current = () =>
  buildCertifiedSupplySnapshot({
    version: "certified-daily-v4",
    asOf: "2026-09-30T04:00:00Z",
    revision: "four-cohort-contract",
    sourceHash: "a".repeat(64),
    soloPeriods: [],
    collaborationPeriods: [],
  });
const point = (blue: number) => [{ pieces: [blue, 0, 0] as const, mass: toWire(q(1)) }];
const historical = () => {
  const snapshot = current();
  return {
    ...snapshot,
    rules: snapshot.rules.map(({ weeklyFixed: _weeklyFixed, ...rule }) => rule),
    events: snapshot.events.filter((event) => event.kind !== "weekly-kits"),
  };
};

describe("versioned certified cohort contracts", () => {
  it("uses the four-cohort prior, keeping three colors", () => {
    const snapshot = current();
    expect(snapshot.version).toBe("certified-daily-v4");
    expect(DEFAULT_PERSONAL_COHORT_WEIGHTS).toEqual(
      [q(1, 7), q(2, 7), q(3, 7), q(1, 7)].map(toWire),
    );
    expect(certifiedCohortWeights(undefined, snapshot.version)).toEqual([
      q(1, 7),
      q(2, 7),
      q(3, 7),
      q(1, 7),
    ]);
    const rates = certifiedRecurringRate(snapshot).map(toNumber);
    expect(rates).toHaveLength(3);
    for (const [k, expected] of [
      22.23202481390751, 5.017296861894071, 1.4174693115540526,
    ].entries())
      expect(rates[k]).toBeCloseTo(expected, 10);
  });

  it("reads historical snapshots with their original equal three-cohort semantics", () => {
    const legacy = {
      ...historical(),
      version: "certified-daily-v1" as const,
      laws: LEGACY_CERTIFIED_SUPPLY_LAWS,
    };
    const bytes = JSON.stringify(legacy);
    expect(assertCertifiedSupplySnapshot(legacy)).toBe(legacy);
    const rate = certifiedRecurringRate(legacy).map(toNumber);
    for (const [k, expected] of [20.452913466875, 3.290737299774, 1.300173072026].entries())
      expect(rate[k]).toBeCloseTo(expected, 8);
    expect(JSON.stringify(legacy)).toBe(bytes);
    expect(() => certifiedRecurringRate(legacy, DEFAULT_PERSONAL_COHORT_WEIGHTS)).toThrow(
      "cohort_weights_invalid",
    );
    expect(() =>
      certifiedRecurringRate(current(), [toWire(q(1)), toWire(q(0)), toWire(q(0))]),
    ).toThrow("cohort_weights_invalid");
  });

  it("requires the version's exact finite-law arity and never falls back for a missing cohort", () => {
    const finite: CertifiedSupplyLaw = {
      id: "finite",
      kind: "finite",
      modelVersion: "explicit-test",
      outcomes: point(99),
      outcomesByCohort: [point(1), point(2), point(3)],
    };
    const legacy = {
      ...historical(),
      version: "certified-daily-v1" as const,
      laws: [...LEGACY_CERTIFIED_SUPPLY_LAWS, finite],
    };
    expect(assertCertifiedSupplySnapshot(legacy)).toBe(legacy);
    expect(() =>
      assertCertifiedSupplySnapshot({ ...current(), laws: [...current().laws, finite] }),
    ).toThrow("cohort_law_invalid");
    expect(() =>
      getCertifiedLawDistribution({ lawId: "finite", count: 1 }, 3, { laws: [finite] }),
    ).toThrow("certified_law_unknown:finite");
    const four: CertifiedSupplyLaw = {
      ...finite,
      outcomesByCohort: [point(1), point(2), point(3), point(4)],
    };
    const next = { ...current(), laws: [...current().laws, four] };
    expect(assertCertifiedSupplySnapshot(next)).toBe(next);
    expect(() =>
      assertCertifiedSupplySnapshot({ ...legacy, laws: [...LEGACY_CERTIFIED_SUPPLY_LAWS, four] }),
    ).toThrow("cohort_law_invalid");
    expect(getCertifiedLawDistribution({ lawId: "finite", count: 1 }, 3, { laws: [four] })).toEqual(
      [{ pieces: [4, 0, 0], mass: q(1) }],
    );
  });
});
