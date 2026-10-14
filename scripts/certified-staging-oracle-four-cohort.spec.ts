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
import { verifyCertifiedLane, verifyPublicPricing } from "./certified-staging-oracle-lane.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

function input(stock: Triple = [20, 0, 0]): CertifiedInput {
  const snapshot = buildCertifiedSupplySnapshot({
    asOf: "2026-09-30T04:00:00Z",
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
    snapshot: { ...snapshot, events: [] },
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

  it("independently checks v2 default pricing, current, batch and day-zero waiting", () => {
    const request = input();
    const output = solveCertified(request);
    const report = verifyCertifiedLane(request, output);
    expect(report.status).toBe("PASS");
    expect(report.pricing.status).toBe("PASS");
    expect(report.current.status).toBe("PASS");
    expect(report.batch.status).toBe("PASS");
    expect(report.waiting).toMatchObject({
      status: "PASS",
      reason: "day0_no_snapshot_arrivals_complete_future_exact_current_invariance",
    });
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
      expect.closeTo(20.80345338533608, 10),
      expect.closeTo(3.588725433322643, 10),
      expect.closeTo(1.4174693115540526, 10),
    ]);
    if (!output.pricing) throw new Error("missing pricing");
    const wrong = {
      ...output,
      pricing: {
        ...output.pricing,
        recurringRate: [
          wire(q(999)),
          output.pricing.recurringRate[1],
          output.pricing.recurringRate[2],
        ] as const,
      },
    };
    expect(verifyPublicPricing(request, wrong).check).toEqual({
      status: "FAIL",
      reason: "pricing_recurring_rate_mismatch",
    });
  });

  it("keeps the fourth prior and pins the unsupported refreshed-cohort waiting certificate", () => {
    const request = input([0, 0, 0]);
    request.cohortWeights = [wire(q(0)), wire(q(0)), wire(q(0)), wire(q(1))];
    const rule = request.snapshot.rules[0];
    if (!rule) throw new Error("missing rule");
    const date = new Date(Date.parse("2026-09-30T00:00:00Z") + 56 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    request.snapshot.events = [
      {
        id: `dispatch:${date}`,
        gameDate: date,
        at: `${date}T08:00:00Z`,
        kind: "dispatch",
        status: "confirmed",
        ruleId: rule.id,
        refs: [{ lawId: "deterministic:0,0,10", count: 1 }],
      },
    ];
    const output = solveCertified(request);
    const report = verifyCertifiedLane(request, output);
    expect(output.pricing?.cohortWeights).toEqual(request.cohortWeights);
    expect(report.pricing.status).toBe("PASS");
    expect(report.current.status).toBe("PASS");
    expect(report.batch.status).toBe("PASS");
    expect(output.waiting.strictBoundaryWitness?.cohort).toBe(3);
    expect(report.waiting).toEqual({
      status: "NOTRUN",
      reason: "independent_refresh_cohort_PMF_not_implemented",
    });
    expect(report.status).toBe("NOTRUN");
    const rate = independentVersionedPricing(request.snapshot, [q(0), q(0), q(0), q(1)]);
    expect(output.pricing?.recurringRate).toEqual(rate.map(wire));
  });

  it("fails closed when the separately pinned prototype bytes change", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(Buffer.from("{}"));
    expect(() => independentFourthCohort()).toThrow("independent_cohort3_pin_mismatch");
  });
});
