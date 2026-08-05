import { describe, expect, it } from "vitest";

import type { ExactInteractiveEvaluation } from "./evaluator/exact-replan-types";
import {
  classifyExactInteractiveCandidate,
  classifyExactInteractiveCandidateSet,
  classifyMcExactCalibration,
} from "./rerank-quality";

function completed(overrides: {
  probability?: number;
  cost?: number;
  consumption?: { blue: number; purple: number; yellow: number };
  violations?: number;
}): Extract<ExactInteractiveEvaluation, { status: "completed" }> {
  return {
    status: "completed",
    scenario: {
      id: "quality-fixture",
      group: "balanced",
      start: { grade: "SR", level: 14, exp: 0 },
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
      internalViolationCount: overrides.violations ?? 0,
      internalFirstViolationWitness: null,
      internalEligibleEmptyCount: 0,
      internalFixedToleranceViolationCount: 0,
      internalFirstFixedToleranceViolationWitness: null,
      boundaryDecisionCount: 0,
      boundaryMaxGap: 0,
      boundaryMaxGapWitness: null,
      boundaryViolationCount: 0,
      boundaryFirstViolationWitness: null,
      boundaryFixedToleranceViolationCount: 0,
      boundaryFirstFixedToleranceViolationWitness: null,
    },
    successProbability: overrides.probability ?? 0.99,
    expectedConsumption: overrides.consumption ?? { blue: 10, purple: 10, yellow: 10 },
    exhaustionProbability: { blue: 0, purple: 0, yellow: 0 },
    minimumRemainingPieces: { blue: 90, purple: 90, yellow: 90 },
    interactiveF: overrides.cost ?? 0.2,
    manualEntryProbability: 0,
    expectedManualEntries: 0,
    successAttemptSelectionProbability: 0,
    expectedSuccessAttemptSelections: 0,
  };
}

describe("rerank quality classification", () => {
  it("describes MC error as calibration evidence rather than a seed cause", () => {
    expect(classifyMcExactCalibration(-0.01, 0.01, 0)).toEqual({
      classification: "consistent_with_sampling_error",
      standardizedError: 1,
    });
    expect(classifyMcExactCalibration(-0.03, 0.01, 0)).toEqual({
      classification: "outside_nominal_95_interval",
      standardizedError: 3,
    });
    expect(classifyMcExactCalibration(0, 0, 0)).toEqual({
      classification: "consistent_with_sampling_error",
      standardizedError: 0,
    });
  });

  it("requires non-worse probability, cost, and total uses for a product candidate", () => {
    const baseline = completed({});
    expect(classifyExactInteractiveCandidate(baseline, completed({ cost: 0.19 }))).toBe(
      "product_candidate",
    );
    expect(
      classifyExactInteractiveCandidate(
        baseline,
        completed({ cost: 0.19, consumption: { blue: 20, purple: 10, yellow: 10 } }),
      ),
    ).toBe("research_tradeoff");
    expect(
      classifyExactInteractiveCandidate(baseline, completed({ cost: 0.19, violations: 1 })),
    ).toBe("rejected");
  });

  it("requires a probability or E[f] benefit across the full candidate set", () => {
    const baseline = completed({});
    const totalOnly = completed({ consumption: { blue: 9, purple: 10, yellow: 10 } });
    expect(classifyExactInteractiveCandidate(baseline, totalOnly)).toBe("rejected");
    expect(
      classifyExactInteractiveCandidateSet(
        [
          { baseline, candidate: totalOnly },
          { baseline, candidate: completed({ cost: 0.19 }) },
        ],
        true,
      ),
    ).toBe("product_candidate");
    expect(
      classifyExactInteractiveCandidateSet(
        [{ baseline, candidate: completed({ cost: 0.19 }) }],
        false,
      ),
    ).toBe("research_tradeoff");
  });
});
