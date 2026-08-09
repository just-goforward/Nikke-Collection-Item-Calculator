import { describe, expect, it } from "vitest";
import { classifyBoundedHybridQuality } from "./bounded-hybrid-quality";
import type { ExactInteractiveEvaluation } from "./evaluator/exact-replan-types";

describe("bounded hybrid quality policy", () => {
  it("passes a strict interactive-F improvement only when every hard axis is non-worse", () => {
    const baseline = completed();
    const candidate = completed({ interactiveF: 0.19, totalBlue: 9.9 });
    expect(classifyBoundedHybridQuality(baseline, candidate).grade).toBe("scenario_pass");
  });

  it("keeps a strict benefit with an exhaustion regression as a research trade-off", () => {
    const baseline = completed();
    const candidate = completed({ interactiveF: 0.19, exhaustionBlue: 0.02 });
    const decision = classifyBoundedHybridQuality(baseline, candidate);
    expect(decision.grade).toBe("quality_tradeoff");
    expect(decision.reasons).toContain("kit_exhaustion_probability_regressed");
  });

  it("keeps a non-worse scenario eligible while leaving strict-benefit adoption to the set gate", () => {
    const baseline = completed();
    const candidate = completed({ totalBlue: 9 });
    const decision = classifyBoundedHybridQuality(baseline, candidate);
    expect(decision.grade).toBe("scenario_pass");
    expect(decision.gates.strictBenefit).toBe(false);
  });

  it("does not turn an incomplete exact evaluation into quality evidence", () => {
    const baseline = completed();
    const candidate: ExactInteractiveEvaluation = {
      status: "verification_incomplete",
      reason: "time_budget_exceeded",
      scenario: baseline.scenario,
      modelId: "candidate",
      elapsedMs: 1,
      solveCalls: 1,
      cachedNodes: 1,
      cachedPolicies: 1,
      gateEvidence: baseline.gateEvidence,
    };
    expect(classifyBoundedHybridQuality(baseline, candidate).grade).toBe("verification_incomplete");
  });
});

function completed(
  overrides: { interactiveF?: number; totalBlue?: number; exhaustionBlue?: number } = {},
): Extract<ExactInteractiveEvaluation, { status: "completed" }> {
  return {
    status: "completed",
    scenario: {
      id: "fixture",
      group: "balanced",
      start: { grade: "SR", level: 10, exp: 0 },
      stock: { blue: 100, purple: 100, yellow: 100 },
    },
    modelId: "fixture",
    elapsedMs: 1,
    solveCalls: 1,
    cachedNodes: 1,
    cachedPolicies: 1,
    gateEvidence: {
      internalDecisionCount: 0,
      internalMaxGap: 0,
      internalMaxGapWitness: null,
      internalViolationCount: 0,
      internalFirstViolationWitness: null,
      internalEligibleEmptyCount: 0,
      internalFixedToleranceViolationCount: 0,
      internalFirstFixedToleranceViolationWitness: null,
      boundaryDecisionCount: 1,
      boundaryMaxGap: 0,
      boundaryMaxGapWitness: null,
      boundaryViolationCount: 0,
      boundaryFirstViolationWitness: null,
      boundaryFixedToleranceViolationCount: 0,
      boundaryFirstFixedToleranceViolationWitness: null,
    },
    successProbability: 0.9,
    expectedConsumption: {
      blue: overrides.totalBlue ?? 10,
      purple: 10,
      yellow: 10,
    },
    exhaustionProbability: {
      blue: overrides.exhaustionBlue ?? 0.01,
      purple: 0,
      yellow: 0,
    },
    minimumRemainingPieces: { blue: 0, purple: 0, yellow: 0 },
    interactiveF: overrides.interactiveF ?? 0.2,
    manualEntryProbability: 0,
    expectedManualEntries: 0,
    successAttemptSelectionProbability: 0,
    expectedSuccessAttemptSelections: 0,
  };
}
