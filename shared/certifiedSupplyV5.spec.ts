import { describe, expect, it } from "vitest";
import { q, toWire } from "./certifiedRational";
import {
  assertCertifiedRuntimeSupplySnapshot,
  assertCertifiedSupplySnapshot,
  buildCertifiedSupplySnapshot,
  certifiedCohortWeights,
} from "./certifiedSupply";
import { LEGACY_CERTIFIED_SUPPLY_LAWS } from "./certifiedSupplyLaws";
import { FIXED_DISPATCH_COHORT_WEIGHTS } from "./certifiedSupplyModel";
import { forecastVersionsForSnapshot } from "./certifiedVersionPolicy";

const snapshot = () =>
  buildCertifiedSupplySnapshot({
    asOf: "2026-10-01T05:00:00+09:00",
    revision: "fixed-dispatch-v5",
    sourceHash: "a".repeat(64),
    soloPeriods: [],
    collaborationPeriods: [],
  });

describe("fixed dispatch v5 policy", () => {
  it("uses three physical cohorts with a new publication pair, not historical v1", () => {
    const value = snapshot();
    expect(value.version).toBe("certified-daily-v5");
    expect(assertCertifiedRuntimeSupplySnapshot(value)).toBe(value);
    expect(certifiedCohortWeights()).toEqual([q(1, 6), q(1, 3), q(1, 2)]);
    expect(FIXED_DISPATCH_COHORT_WEIGHTS).toEqual([q(1, 6), q(2, 6), q(3, 6)].map(toWire));
    expect(certifiedCohortWeights(undefined, "certified-daily-v1")).toEqual([
      q(1, 3),
      q(1, 3),
      q(1, 3),
    ]);
    expect(forecastVersionsForSnapshot(value.version)).toEqual({
      payloadVersion: 6,
      rulesVersion: "schedule-kit-v5",
    });
    expect(() =>
      assertCertifiedSupplySnapshot({ ...value, laws: LEGACY_CERTIFIED_SUPPLY_LAWS }),
    ).toThrow("builtin_law_version_invalid");
  });
  it("rejects selections, inferred posteriors and a padded fourth cohort", () => {
    for (const weights of [
      [toWire(q(1)), toWire(q(0)), toWire(q(0))],
      [toWire(q(1, 3)), toWire(q(1, 3)), toWire(q(1, 3))],
      [toWire(q(1, 6)), toWire(q(1, 3)), toWire(q(1, 2)), toWire(q(0))],
    ] as const) {
      expect(() => certifiedCohortWeights(weights)).toThrow("certified_cohort_weights_invalid");
    }
    expect(
      certifiedCohortWeights([
        { numerator: "2", denominator: "12" },
        { numerator: "4", denominator: "12" },
        { numerator: "6", denominator: "12" },
      ]),
    ).toEqual([q(1, 6), q(1, 3), q(1, 2)]);
  });
  it("checks three-entry law arrays structurally while runtime still forbids finite laws", () => {
    const base = snapshot();
    const point = [{ pieces: [1, 0, 0] as const, mass: toWire(q(1)) }];
    const law = {
      id: "fixture",
      kind: "finite" as const,
      modelVersion: "test",
      outcomesByCohort: [point, point, point] as const,
    };
    const value = { ...base, laws: [...base.laws, law] };
    expect(assertCertifiedSupplySnapshot(value)).toBe(value);
    expect(() => assertCertifiedRuntimeSupplySnapshot(value)).toThrow();
    expect(() =>
      assertCertifiedSupplySnapshot({
        ...base,
        laws: [...base.laws, { ...law, outcomesByCohort: [point, point, point, point] }],
      }),
    ).toThrow("cohort_law_invalid");
  });
});
