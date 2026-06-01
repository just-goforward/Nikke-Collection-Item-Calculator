import { describe, expect, it } from "vitest";

import { holmBonferroniWorseningDecisions, pairedBootstrapImprovement } from "./tail-statistics";

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe("paired tail-risk decisions", () => {
  it("reports deterministic confirmed worsening for a clearly depleted candidate", () => {
    const baseline = Array.from({ length: 40 }, () => 100);
    const candidate = Array.from({ length: 40 }, () => 0);
    const first = pairedBootstrapImprovement(baseline, candidate, {
      higherIsBetter: true,
      statistic: mean,
      resamples: 1000,
      seed: 20260505,
    });
    const second = pairedBootstrapImprovement(baseline, candidate, {
      higherIsBetter: true,
      statistic: mean,
      resamples: 1000,
      seed: 20260505,
    });

    expect(second).toEqual(first);
    expect(first.pointImprovement).toBe(-100);
    expect(first.confidenceUpper).toBeLessThan(0);
    expect(first.adversePValue).toBeCloseTo(1 / 1001, 10);

    const decisions = holmBonferroniWorseningDecisions([
      { id: "residual-blue-p05", adversePValue: first.adversePValue },
      { id: "autonomy-p05", adversePValue: 0.7 },
    ]);
    expect(decisions[0].confirmedWorsening).toBe(true);
    expect(decisions[1].confirmedWorsening).toBe(false);
  });

  it("orients lower-is-better metrics so reduced depletion is not worsening", () => {
    const result = pairedBootstrapImprovement([1, 1, 1, 1], [0, 0, 0, 0], {
      higherIsBetter: false,
      statistic: mean,
      resamples: 100,
    });

    expect(result.pointImprovement).toBe(1);
    expect(result.adversePValue).toBe(1);
  });
});
