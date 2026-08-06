import { describe, expect, it } from "vitest";

import { cvarUpperTail } from "./metrics";
import {
  holmBonferroniWorseningDecisions,
  pairedBootstrapCvarImprovement,
  pairedBootstrapImprovement,
} from "./tail-statistics";

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
    const firstDecision = decisions[0];
    const secondDecision = decisions[1];
    if (!firstDecision || !secondDecision) throw new Error("Expected two Holm decisions.");
    expect(firstDecision.confirmedWorsening).toBe(true);
    expect(secondDecision.confirmedWorsening).toBe(false);
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

  it("computes both CVaR directions from one deterministic paired resample stream", () => {
    const baseline = [0, 1, 2, 3, 20, 30];
    const candidate = [0, 1, 2, 3, 10, 20];
    const result = pairedBootstrapCvarImprovement(baseline, candidate, {
      alpha: 0.9,
      resamples: 1000,
      seed: 20260805,
    });
    const reverse = pairedBootstrapCvarImprovement(candidate, baseline, {
      alpha: 0.9,
      resamples: 1000,
      seed: 20260805,
    });
    const generic = pairedBootstrapImprovement(baseline, candidate, {
      higherIsBetter: false,
      statistic: (values) => cvarUpperTail(values, 0.9),
      resamples: 1000,
      seed: 20260805,
    });
    const genericReverse = pairedBootstrapImprovement(candidate, baseline, {
      higherIsBetter: false,
      statistic: (values) => cvarUpperTail(values, 0.9),
      resamples: 1000,
      seed: 20260805,
    });

    expect(result.pointImprovement).toBe(10);
    expect(result.pointImprovement).toBe(generic.pointImprovement);
    expect(result.confidenceLower).toBe(generic.confidenceLower);
    expect(result.confidenceUpper).toBe(generic.confidenceUpper);
    expect(result.adversePValue).toBe(generic.adversePValue);
    expect(result.reverseAdversePValue).toBe(genericReverse.adversePValue);
    expect(reverse.pointImprovement).toBe(-result.pointImprovement);
    expect(result.reverseAdversePValue).toBe(reverse.adversePValue);
    expect(result.adversePValue).toBe(reverse.reverseAdversePValue);
  });
});
