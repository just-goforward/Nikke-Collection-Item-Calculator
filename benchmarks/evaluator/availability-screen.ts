import type { Kit } from "../../src/types";
import {
  type AvailabilitySliderCandidate,
  BASELINE_AVAILABILITY_CANDIDATE,
  solveAvailabilityCandidate,
} from "../models/availability-grid";
import type { SolverScenario } from "../scenarios/fixed-grid";

type RootRecommendation = {
  possible: boolean;
  firstAction: Kit | null;
  runCount: number | null;
  successProbability: number | null;
  probabilityGap: number | null;
  resourceCost: number | null;
};
type ScreenableSolverResult = {
  possible?: boolean;
  best?: {
    firstAction?: Kit | null;
    run?: { count?: number };
    successProbability?: number;
    probabilityGap?: number | null;
    resourceCost?: number;
  };
  topCandidates?: Array<{
    successProbability?: number;
    resourceCost?: number;
  }>;
  stats?: {
    gateAudit?: {
      eligibleEmptyCount?: number;
      maxGap?: number;
      fixedToleranceViolationCount?: number;
    };
  };
};

export type AvailabilityScreenResult = {
  scenarioId: string;
  candidateId: string;
  status: "screened" | "hard-infeasible" | "error";
  baseline: RootRecommendation;
  candidate: RootRecommendation;
  firstActionChanged: boolean;
  runCountChanged: boolean;
  topSuccessProbabilityGap: number | null;
  topResourceCostGap: number | null;
  eligibleEmptyCount: number;
  maxChosenGap: number;
  fixedToleranceViolationCount: number;
  promoteScore: number;
  errorMessage?: string;
};

function rootRecommendation(result: ScreenableSolverResult): RootRecommendation {
  if (!result.possible || !result.best) {
    return {
      possible: false,
      firstAction: null,
      runCount: null,
      successProbability: null,
      probabilityGap: null,
      resourceCost: null,
    };
  }
  return {
    possible: true,
    firstAction: result.best.firstAction as Kit,
    runCount: Number(result.best.run?.count ?? 1),
    successProbability: Number(result.best.successProbability),
    probabilityGap: Number(result.best.probabilityGap ?? 0),
    resourceCost: Number(result.best.resourceCost),
  };
}

function topGap(result: ScreenableSolverResult, field: "successProbability" | "resourceCost") {
  const candidates = Array.isArray(result.topCandidates) ? result.topCandidates : [];
  if (candidates.length < 2) return null;
  const first = candidates[0];
  const second = candidates[1];
  if (!first || !second) return null;
  return Math.abs(Number(first[field]) - Number(second[field]));
}

function promoteScore(result: AvailabilityScreenResult) {
  let score = 0;
  if (result.firstActionChanged) score += 4;
  if (result.runCountChanged) score += 2;
  if (result.eligibleEmptyCount > 0) score += 2;
  if (result.maxChosenGap > 0.007) score += 2;
  if (result.topSuccessProbabilityGap !== null && result.topSuccessProbabilityGap <= 0.003) {
    score += 1;
  }
  if (result.topResourceCostGap !== null && result.topResourceCostGap <= 0.01) {
    score += 1;
  }
  return score;
}

export function screenAvailabilityCandidate(
  scenario: SolverScenario,
  candidate: AvailabilitySliderCandidate,
  baselineResult?: ReturnType<typeof solveAvailabilityCandidate>,
): AvailabilityScreenResult {
  try {
    const input = { start: scenario.start, stock: scenario.stock, strategy: "supply" as const };
    const resolvedBaselineResult =
      baselineResult || solveAvailabilityCandidate(input, BASELINE_AVAILABILITY_CANDIDATE);
    const candidateResult =
      candidate.id === BASELINE_AVAILABILITY_CANDIDATE.id
        ? resolvedBaselineResult
        : solveAvailabilityCandidate(input, candidate);
    const baseline = rootRecommendation(resolvedBaselineResult);
    const candidateRoot = rootRecommendation(candidateResult);
    const gateAudit = candidateResult.stats?.gateAudit;

    const result: AvailabilityScreenResult = {
      scenarioId: scenario.id,
      candidateId: candidate.id,
      status: candidateRoot.possible ? "screened" : "hard-infeasible",
      baseline,
      candidate: candidateRoot,
      firstActionChanged:
        baseline.firstAction !== null &&
        candidateRoot.firstAction !== null &&
        baseline.firstAction !== candidateRoot.firstAction,
      runCountChanged:
        baseline.runCount !== null &&
        candidateRoot.runCount !== null &&
        baseline.runCount !== candidateRoot.runCount,
      topSuccessProbabilityGap: topGap(candidateResult, "successProbability"),
      topResourceCostGap: topGap(candidateResult, "resourceCost"),
      eligibleEmptyCount: Number(gateAudit?.eligibleEmptyCount ?? 0),
      maxChosenGap: Number(gateAudit?.maxGap ?? 0),
      fixedToleranceViolationCount: Number(gateAudit?.fixedToleranceViolationCount ?? 0),
      promoteScore: 0,
    };
    return { ...result, promoteScore: promoteScore(result) };
  } catch (error) {
    return {
      scenarioId: scenario.id,
      candidateId: candidate.id,
      status: "error",
      baseline: rootRecommendation({ possible: false }),
      candidate: rootRecommendation({ possible: false }),
      firstActionChanged: false,
      runCountChanged: false,
      topSuccessProbabilityGap: null,
      topResourceCostGap: null,
      eligibleEmptyCount: 0,
      maxChosenGap: 0,
      fixedToleranceViolationCount: 0,
      promoteScore: 0,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
