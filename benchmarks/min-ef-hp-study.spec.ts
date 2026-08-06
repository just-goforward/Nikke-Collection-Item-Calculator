import { describe, expect, it } from "vitest";

import type { ExactInteractiveEvaluation } from "./evaluator/exact-replan-types";
import {
  HP_BASELINE_ID,
  HP_CANDIDATES,
  HP_MANDATORY_SHORTLIST_IDS,
  type HpCandidateScreenSummary,
  type HpRootScreenRecord,
  hpAvailabilityObjective,
  hpCandidateById,
  hpNormPowerValue,
  summarizeHpScreening,
} from "./min-ef-hp-model";
import {
  classifyHpCandidate,
  evaluateHpExactGate,
  passesHpPerformanceGate,
} from "./min-ef-hp-quality";
import { shouldAdvanceExactEvaluation } from "./min-ef-hp-report";
import { selectHpShortlist } from "./min-ef-hp-selection";
import { evaluateHpTailGate, selectHpTailWinner } from "./min-ef-hp-tail";

function completed(
  overrides: {
    probability?: number;
    totalUses?: number;
    exhaustion?: number;
    violations?: number;
  } = {},
): Extract<ExactInteractiveEvaluation, { status: "completed" }> {
  const pieces = (overrides.totalUses ?? 3) * 10;
  return {
    status: "completed",
    scenario: {
      id: "fixture",
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
    expectedConsumption: { blue: pieces, purple: 0, yellow: 0 },
    exhaustionProbability: {
      blue: overrides.exhaustion ?? 0,
      purple: 0,
      yellow: 0,
    },
    minimumRemainingPieces: { blue: 70, purple: 100, yellow: 100 },
    interactiveF: 0.2,
    manualEntryProbability: 0,
    expectedManualEntries: 0,
    successAttemptSelectionProbability: 0,
    expectedSuccessAttemptSelections: 0,
  };
}

function summary(candidateId: string, debt: number, uses: number): HpCandidateScreenSummary {
  return {
    candidateId,
    completed: 1,
    comparableScenarios: 1,
    newFailures: 0,
    recoveredScenarios: 0,
    maxSuccessProbabilityLoss: 0,
    meanTotalExpectedUses: uses,
    worstSupplyDebtDays: debt,
  };
}

describe("H/p study contracts", () => {
  it("defines a unique 7 by 7 candidate grid without losing infinity", () => {
    expect(HP_CANDIDATES).toHaveLength(49);
    expect(new Set(HP_CANDIDATES.map((candidate) => candidate.id)).size).toBe(49);
    expect(HP_BASELINE_ID).toBe("H0.75-p3");
    expect(hpNormPowerValue(hpCandidateById("H0.75-pinf").normPower)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("reports the same finite and infinity p-norm shape used by Rust", () => {
    const stock = { blue: 0, purple: 0, yellow: 0 };
    const vector = { blue: 1, purple: 1, yellow: 0 };
    const l1 = hpAvailabilityObjective(vector, stock, hpCandidateById("H0.75-p1"));
    const l2 = hpAvailabilityObjective(vector, stock, hpCandidateById("H0.75-p2"));
    const linf = hpAvailabilityObjective(vector, stock, hpCandidateById("H0.75-pinf"));
    expect(l1).toBeGreaterThan(l2);
    expect(l2).toBeGreaterThan(linf);
  });

  it("starts missing exact work, resumes checkpoints, and skips terminal results", () => {
    expect(shouldAdvanceExactEvaluation(undefined)).toBe(true);
    expect(shouldAdvanceExactEvaluation({ status: "verification_incomplete" })).toBe(true);
    expect(shouldAdvanceExactEvaluation(completed())).toBe(false);
  });

  it("keeps mandatory sensitivity points and deterministically fills the shortlist", () => {
    const summaries = HP_CANDIDATES.map((candidate, index) =>
      summary(candidate.id, 100 + index, 10 + index),
    );
    const shortlist = selectHpShortlist(summaries);
    expect(shortlist.length).toBeGreaterThanOrEqual(HP_MANDATORY_SHORTLIST_IDS.size);
    expect(shortlist.length).toBeLessThanOrEqual(16);
    for (const id of HP_MANDATORY_SHORTLIST_IDS) expect(shortlist).toContain(id);
    expect(selectHpShortlist(summaries)).toEqual(shortlist);
  });

  it("summarizes comparable roots without treating missing baseline roots as regressions", () => {
    const metric = {
      firstAction: "blue" as const,
      successProbability: 0.9,
      maxSuccessProbability: 0.9,
      expectedConsumption: { blue: 10, purple: 0, yellow: 0 },
      totalExpectedUses: 1,
      referenceInteractiveF: 0.1,
      maxSupplyDebtDays: 2,
      optimizerExpectedCost: 0.1,
      nodeCount: 1,
    };
    const make = (
      candidateId: string,
      scenarioId: string,
      metrics: typeof metric | null,
    ): HpRootScreenRecord => ({
      candidateId,
      scenarioId,
      minEfOutcome: metrics ? "completed" : "memo_full",
      phase2Outcome: metrics ? "not_run" : "memo_full",
      selectedBackend: metrics ? "rust-min-ef" : null,
      metrics,
      errorMessage: null,
      elapsedMs: 1,
    });
    const candidateId = "H0.5-p3";
    const result = summarizeHpScreening([
      make(HP_BASELINE_ID, "a", metric),
      make(HP_BASELINE_ID, "b", null),
      make(candidateId, "a", metric),
      make(candidateId, "b", metric),
    ]).find((entry) => entry.candidateId === candidateId);
    expect(result).toMatchObject({ comparableScenarios: 1, newFailures: 0, recoveredScenarios: 1 });
  });

  it("applies the one-percent total-use and per-kit exhaustion hard boundaries", () => {
    const baseline = completed({ totalUses: 100, exhaustion: 0.1 });
    expect(
      evaluateHpExactGate(baseline, completed({ totalUses: 101, exhaustion: 0.1 })).status,
    ).toBe("passed");
    expect(
      evaluateHpExactGate(baseline, completed({ totalUses: 101.00000001, exhaustion: 0.1 }))
        .violations,
    ).toContain("total_uses");
    expect(
      evaluateHpExactGate(baseline, completed({ totalUses: 100, exhaustion: 0.10000000001 }))
        .violations,
    ).toContain("exhaustion_blue");
  });

  it("requires completed exact, tail, D1, and performance evidence", () => {
    const gate = evaluateHpExactGate(completed(), completed({ totalUses: 2.9 }));
    expect(
      classifyHpCandidate({
        exactGates: [gate],
        tailRiskPassed: true,
        d1RobustnessPassed: true,
        performancePassed: true,
        hasStrictTailImprovement: true,
        hasNewFailure: false,
      }),
    ).toBe("product_candidate");
    expect(
      classifyHpCandidate({
        exactGates: [gate],
        tailRiskPassed: null,
        d1RobustnessPassed: true,
        performancePassed: true,
        hasStrictTailImprovement: true,
        hasNewFailure: false,
      }),
    ).toBe("verification_incomplete");
  });

  it("does not relabel a hard-gate rejection as incomplete when later gates were not run", () => {
    const gate = evaluateHpExactGate(completed(), completed({ probability: 0.98 }));
    expect(gate.status).toBe("failed");
    expect(
      classifyHpCandidate({
        exactGates: [gate],
        tailRiskPassed: null,
        d1RobustnessPassed: null,
        performancePassed: null,
        hasStrictTailImprovement: false,
        hasNewFailure: false,
      }),
    ).toBe("rejected");
  });

  it("does not relabel a tail-risk rejection as incomplete when later gates were skipped", () => {
    const gate = evaluateHpExactGate(completed(), completed({ totalUses: 2.9 }));
    expect(
      classifyHpCandidate({
        exactGates: [gate],
        tailRiskPassed: false,
        d1RobustnessPassed: null,
        performancePassed: null,
        hasStrictTailImprovement: false,
        hasNewFailure: false,
      }),
    ).toBe("rejected");
  });

  it("applies separate cold and warm performance limits", () => {
    expect(
      passesHpPerformanceGate({
        baselineColdP95Ms: 100,
        candidateColdP95Ms: 110,
        baselineWarmP95Ms: 100,
        candidateWarmP95Ms: 150,
      }),
    ).toBe(true);
    expect(
      passesHpPerformanceGate({
        baselineColdP95Ms: 100,
        candidateColdP95Ms: 111,
        baselineWarmP95Ms: 100,
        candidateWarmP95Ms: 150,
      }),
    ).toBe(false);
  });

  it("accepts CRN tail samples only when there is no worsening and one Holm-adjusted improvement", () => {
    const baseline = Array.from({ length: 200 }, (_, index) => (index < 20 ? 100 : 20));
    const candidate = baseline.map((value) => value - 10);
    const result = evaluateHpTailGate([
      { panelId: "a", baseline, candidate },
      { panelId: "b", baseline, candidate },
    ]);
    expect(result.passed).toBe(true);
    expect(result.hasStrictImprovement).toBe(true);
  });

  it("uses baseline proximity only when held-out tail differences are indistinguishable", () => {
    const candidates = [
      { candidateId: "point-best", maxPanelCvar90: 10, baselineDistance: 2 },
      { candidateId: "near-baseline", maxPanelCvar90: 10.1, baselineDistance: 0.1 },
    ];
    expect(selectHpTailWinner(candidates, () => true).selectedCandidateId).toBe("near-baseline");
    expect(selectHpTailWinner(candidates, () => false).selectedCandidateId).toBe("point-best");
  });
});
