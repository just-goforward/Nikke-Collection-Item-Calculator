import type {
  ExactInteractiveEvaluation,
  ExactInteractiveReplanCheckpoint,
} from "./evaluator/exact-replan-types";
import type { TrajectoryEvaluation } from "./evaluator/trajectory";
import type { TrajectoryTailSummary } from "./metrics";

export type DeepSliceConfig = {
  candidateIds: string[];
  scenarioIds: string[];
  journeyPanelIds: string[];
  seeds: number[];
  runsPerSeed: number;
  exactTotalBudgetMs: number;
  trajectoryBudgetMs: number;
};

export type AvailabilityScreenReport = {
  deepCandidateIds?: string[];
};

export type ExactSummary = {
  status: ExactInteractiveEvaluation["status"];
  reason?: string;
  scenario: string;
  modelId: string;
  elapsedMs: number;
  solveCalls: number;
  cachedNodes: number;
  cachedPolicies: number;
  gateEvidence: ExactInteractiveEvaluation["gateEvidence"] | null;
  successProbability?: number;
  exactLossVsA?: number | null;
  relativeLossVsA?: number | null;
  expectedConsumption?: Extract<
    ExactInteractiveEvaluation,
    { status: "completed" }
  >["expectedConsumption"];
  interactiveF?: number;
  manualEntryProbability?: number;
  expectedManualEntries?: number;
  successAttemptSelectionProbability?: number;
  expectedSuccessAttemptSelections?: number;
};

export type TrajectoryJobSummary =
  | {
      status: "completed";
      scenario: string;
      modelId: string;
      seed: number;
      runs: number;
      elapsedMs: number;
      solveCalls: number;
      cachedPolicies: number;
      summary: TrajectoryTailSummary;
    }
  | {
      status: Extract<TrajectoryEvaluation, { status: "verification_incomplete" }>["status"];
      reason: Extract<TrajectoryEvaluation, { status: "verification_incomplete" }>["reason"];
      scenario: string;
      modelId: string;
      seed: number;
      runsCompleted: number;
      elapsedMs: number;
      solveCalls: number;
      cachedPolicies: number;
    };

export type JourneyPanelSummary = TrajectoryJobSummary & {
  supplyDebtStatus: "completed" | "judgement_incomplete";
};

export type JourneyDemandSummary = {
  candidateId: string;
  panels: JourneyPanelSummary[];
  maxPanelSupplyDebtCvar90: number | null;
};

export type DeepSliceState = {
  version: 1;
  config: DeepSliceConfig;
  phase: "exact" | "finite-tail" | "journey-tail" | "completed";
  exactJobIndex: number;
  exactSessionCheckpoint: ExactInteractiveReplanCheckpoint | null;
  exactResults: ExactSummary[];
  finiteTailJobIndex: number;
  finiteStockTail: TrajectoryJobSummary[];
  journeyTailJobIndex: number;
  journeyTail: TrajectoryJobSummary[];
};

export function readScreenReport(value: unknown): AvailabilityScreenReport | null {
  if (typeof value !== "object" || value === null) return null;
  const deepCandidateIds =
    "deepCandidateIds" in value && Array.isArray(value.deepCandidateIds)
      ? value.deepCandidateIds.filter((id): id is string => typeof id === "string")
      : null;
  return {
    ...(deepCandidateIds ? { deepCandidateIds } : {}),
  };
}

export function readDeepSliceState(
  value: unknown,
  expectedConfig: DeepSliceConfig,
): DeepSliceState {
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1) {
    throw new Error("Unsupported availability deep checkpoint version.");
  }
  return {
    version: 1,
    config: "config" in value ? (value.config as DeepSliceConfig) : expectedConfig,
    phase:
      "phase" in value &&
      (value.phase === "exact" ||
        value.phase === "finite-tail" ||
        value.phase === "journey-tail" ||
        value.phase === "completed")
        ? value.phase
        : "exact",
    exactJobIndex:
      "exactJobIndex" in value && typeof value.exactJobIndex === "number" ? value.exactJobIndex : 0,
    exactSessionCheckpoint:
      "exactSessionCheckpoint" in value
        ? (value.exactSessionCheckpoint as ExactInteractiveReplanCheckpoint | null)
        : null,
    exactResults:
      "exactResults" in value && Array.isArray(value.exactResults)
        ? (value.exactResults as ExactSummary[])
        : [],
    finiteTailJobIndex:
      "finiteTailJobIndex" in value && typeof value.finiteTailJobIndex === "number"
        ? value.finiteTailJobIndex
        : 0,
    finiteStockTail:
      "finiteStockTail" in value && Array.isArray(value.finiteStockTail)
        ? (value.finiteStockTail as TrajectoryJobSummary[])
        : [],
    journeyTailJobIndex:
      "journeyTailJobIndex" in value && typeof value.journeyTailJobIndex === "number"
        ? value.journeyTailJobIndex
        : 0,
    journeyTail:
      "journeyTail" in value && Array.isArray(value.journeyTail)
        ? (value.journeyTail as TrajectoryJobSummary[])
        : [],
  };
}

export function sameExactConfig(left: DeepSliceConfig, right: DeepSliceConfig): boolean {
  // journeyPanelIds is intentionally excluded: the exact-gate and finite-stock-tail phases do not
  // depend on journey panels, so adding/removing a journey panel must NOT invalidate those
  // expensive phases.
  return (
    JSON.stringify(comparableExactConfig(left)) === JSON.stringify(comparableExactConfig(right))
  );
}

function comparableExactConfig(config: DeepSliceConfig): Omit<DeepSliceConfig, "journeyPanelIds"> {
  return {
    candidateIds: config.candidateIds,
    scenarioIds: config.scenarioIds,
    seeds: config.seeds,
    runsPerSeed: config.runsPerSeed,
    exactTotalBudgetMs: config.exactTotalBudgetMs,
    trajectoryBudgetMs: config.trajectoryBudgetMs,
  };
}
