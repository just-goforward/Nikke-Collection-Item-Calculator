import type { ExactInteractiveEvaluation } from "./evaluator/exact-replan-types";
import type { TrajectoryEvaluation } from "./evaluator/trajectory";
import type { AvailabilitySliderCandidate } from "./models/availability-grid";
import type { SolverScenario } from "./scenarios/fixed-grid";

type AvailabilityModule = typeof import("./models/availability-grid");
type MetricsModule = typeof import("./metrics");
type TrajectoryModule = typeof import("./evaluator/trajectory");

export type DeepExactSummary = {
  status: ExactInteractiveEvaluation["status"];
  reason?: string;
  scenario: string;
  modelId: string;
  elapsedMs?: number;
  solveCalls?: number;
  cachedNodes?: number;
  cachedPolicies?: number;
  gateEvidence?: ExactInteractiveEvaluation["gateEvidence"];
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

export type DeepTrajectorySummary =
  | {
      status: "completed";
      scenario: string;
      modelId: string;
      seeds: number[];
      runsPerSeed: number;
      totalRuns: number;
      evaluations: Array<{
        seed: number;
        runs: number;
        elapsedMs: number;
        solveCalls: number;
        cachedPolicies: number;
      }>;
      summary: ReturnType<MetricsModule["summarizeTrajectories"]>;
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

export type DeepJourneyPanelSummary = DeepTrajectorySummary & {
  supplyDebtStatus: "completed" | "judgement_incomplete";
};

export function summarizeDeepExact(
  result: ExactInteractiveEvaluation,
  baseline: ExactInteractiveEvaluation | undefined,
): DeepExactSummary {
  const common = {
    status: result.status,
    ...(result.status !== "completed" ? { reason: result.reason } : {}),
    scenario: result.scenario.id,
    modelId: result.modelId,
    elapsedMs: result.elapsedMs,
    solveCalls: result.solveCalls,
    cachedNodes: result.cachedNodes,
    cachedPolicies: result.cachedPolicies,
    gateEvidence: result.gateEvidence,
  };
  if (result.status !== "completed") return common;
  const baselineP =
    baseline && baseline.status === "completed" ? baseline.successProbability : Number.NaN;
  return {
    ...common,
    successProbability: result.successProbability,
    exactLossVsA: Number.isFinite(baselineP) ? baselineP - result.successProbability : null,
    relativeLossVsA:
      Number.isFinite(baselineP) && baselineP > 0
        ? (baselineP - result.successProbability) / baselineP
        : null,
    expectedConsumption: result.expectedConsumption,
    interactiveF: result.interactiveF,
    manualEntryProbability: result.manualEntryProbability,
    expectedManualEntries: result.expectedManualEntries,
    successAttemptSelectionProbability: result.successAttemptSelectionProbability,
    expectedSuccessAttemptSelections: result.expectedSuccessAttemptSelections,
  };
}

export function baselineIncompleteDeepExactSummary(
  scenarioId: string,
  candidateId: string,
): DeepExactSummary {
  return {
    status: "verification_incomplete",
    reason: "baseline_incomplete",
    scenario: scenarioId,
    modelId: candidateId,
  };
}

export function collectDeepTrajectorySummary(args: {
  scenario: SolverScenario;
  candidate: AvailabilitySliderCandidate;
  seeds: readonly number[];
  runsPerSeed: number;
  trajectoryBudgetMs: number;
  availability: AvailabilityModule;
  metrics: MetricsModule;
  trajectory: TrajectoryModule;
}): DeepTrajectorySummary {
  const samples: Extract<TrajectoryEvaluation, { status: "completed" }>["samples"] = [];
  const evaluations: Extract<DeepTrajectorySummary, { status: "completed" }>["evaluations"] = [];
  for (const seed of args.seeds) {
    const result = args.trajectory.collectInteractiveTrajectories(args.scenario, {
      modelId: args.candidate.id,
      costModel: args.availability.availabilityCostModelFor(args.candidate),
      toleranceOverride: args.candidate.tolerance,
      runs: args.runsPerSeed,
      seed,
      timeBudgetMs: args.trajectoryBudgetMs,
    });
    if (result.status !== "completed") {
      return {
        status: result.status,
        reason: result.reason,
        scenario: args.scenario.id,
        modelId: args.candidate.id,
        seed,
        runsCompleted: result.runsCompleted,
        elapsedMs: result.elapsedMs,
        solveCalls: result.solveCalls,
        cachedPolicies: result.cachedPolicies,
      };
    }
    evaluations.push({
      seed,
      runs: result.runs,
      elapsedMs: result.elapsedMs,
      solveCalls: result.solveCalls,
      cachedPolicies: result.cachedPolicies,
    });
    samples.push(...result.samples);
  }
  return {
    status: "completed",
    scenario: args.scenario.id,
    modelId: args.candidate.id,
    seeds: [...args.seeds],
    runsPerSeed: args.runsPerSeed,
    totalRuns: samples.length,
    evaluations,
    summary: args.metrics.summarizeTrajectories(samples),
  };
}

export function withSupplyDebtStatus(summary: DeepTrajectorySummary): DeepJourneyPanelSummary {
  return {
    ...summary,
    supplyDebtStatus:
      summary.status === "completed" && summary.summary.completionRate >= 0.995
        ? "completed"
        : "judgement_incomplete",
  };
}

export function maxCompletedPanelSupplyDebt(
  panelResults: readonly DeepJourneyPanelSummary[],
): number | null {
  const completedPanelDebtValues = panelResults
    .filter(isCompletedJourneyPanel)
    .map((panel) => panel.summary.maxSupplyDebtDaysCvar90);
  return completedPanelDebtValues.length > 0 ? Math.max(...completedPanelDebtValues) : null;
}

function isCompletedJourneyPanel(panel: DeepJourneyPanelSummary): panel is Extract<
  DeepTrajectorySummary,
  { status: "completed" }
> & {
  supplyDebtStatus: "completed";
} {
  return panel.status === "completed" && panel.supplyDebtStatus === "completed";
}
