import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildCertifiedSupplySnapshot } from "../shared/certifiedSupply.ts";
import { solveCertified } from "../src/certified/solver.ts";
import type { CertifiedInput, Triple } from "../src/certified/types.ts";
import { approx, q, wire } from "./certified-staging-oracle.ts";
import {
  independentFourthCohort,
  independentVersionedPricing,
} from "./certified-staging-oracle-four-cohort-pricing.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

function input(stock: Triple = [20, 0, 0]): CertifiedInput {
  const snapshot = buildCertifiedSupplySnapshot({
    // Wednesday 13:00 KST under the v3 rule (the weekly grant is at 05:00 KST).
    asOf: "2026-10-14T04:00:00Z",
    revision: "four-cohort-independent-lane",
    sourceHash: "a".repeat(64),
    soloPeriods: [],
    collaborationPeriods: [],
    sourceStatus: "healthy",
  });
  return {
    grade: "SR",
    level: 14,
    exp: 0,
    stock,
    asOf: snapshot.asOf,
    snapshot: {
      ...snapshot,
      version: "certified-daily-v3",
      rules: snapshot.rules.map((rule) => ({
        ...rule,
        id: "schedule-kit-v3:documented-physical-supply-v2",
      })),
      events: snapshot.events.map((event) => ({
        ...event,
        ruleId: "schedule-kit-v3:documented-physical-supply-v2",
      })),
    },
  };
}

describe("independent four-cohort certified lane", () => {
  it("pins the prototype expectation without importing product expectation constants", () => {
    expect(independentFourthCohort().map(approx)).toEqual([
      expect.closeTo(9.966514778612282, 12),
      expect.closeTo(2.888196645234681, 12),
      expect.closeTo(1.0588743327682388, 12),
    ]);
  });

  it("independently prices the v3 default population including the Wednesday weekly grant", () => {
    const request = input();
    expect(request.snapshot.version).toBe("certified-daily-v3");
    const output = solveCertified(request);
    // Public SR14 blue great chance 1/10: two uses give 1 - (9/10)^2,
    // with 10 guaranteed pieces plus 10 more on the first ordinary outcome.
    expect(output.current).toMatchObject({
      kit: "blue",
      uses: 2,
      value: { successP: wire(q(19, 100)), expectedTotalConsumptionC: wire(q(19)) },
    });
    const rates = independentVersionedPricing(request.snapshot, [
      q(1, 7),
      q(2, 7),
      q(3, 7),
      q(1, 7),
    ]);
    expect(output.pricing?.recurringRate).toEqual(rates.map(wire));
    expect(rates.map(approx)).toEqual([
      expect.closeTo(22.2320248, 6),
      expect.closeTo(5.0172969, 6),
      expect.closeTo(1.4174693, 6),
    ]);
  });

  it("keeps an explicit pure fourth prior in the independent v3 price", () => {
    const request = input([0, 0, 0]);
    request.cohortWeights = [wire(q(0)), wire(q(0)), wire(q(0)), wire(q(1))];
    const output = solveCertified(request);
    expect(output.pricing?.cohortWeights).toEqual(request.cohortWeights);
    const rate = independentVersionedPricing(request.snapshot, [q(0), q(0), q(0), q(1)]);
    expect(output.pricing?.recurringRate).toEqual(rate.map(wire));
  });

  it("fails closed when the separately pinned prototype bytes change", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(Buffer.from("{}"));
    expect(() => independentFourthCohort()).toThrow("independent_cohort3_pin_mismatch");
  });
});
