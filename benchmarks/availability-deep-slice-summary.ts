import { writeFile } from "node:fs/promises";
import type {
  DeepSliceState,
  ExactSummary,
  JourneyDemandSummary,
  JourneyPanelSummary,
  TrajectoryJobSummary,
} from "./availability-deep-slice-state.ts";
import type { ExactInteractiveEvaluation } from "./evaluator/exact-replan-types";
import type { TrajectoryEvaluation } from "./evaluator/trajectory";

type MetricsModule = typeof import("./metrics");

export function summarizeExact(result: ExactInteractiveEvaluation): ExactSummary {
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
  return {
    ...common,
    successProbability: result.successProbability,
    expectedConsumption: result.expectedConsumption,
    interactiveF: result.interactiveF,
    manualEntryProbability: result.manualEntryProbability,
    expectedManualEntries: result.expectedManualEntries,
    successAttemptSelectionProbability: result.successAttemptSelectionProbability,
    expectedSuccessAttemptSelections: result.expectedSuccessAttemptSelections,
  };
}

export function completedBaselineForScenario(
  exactResults: readonly ExactSummary[],
  baselineId: string,
  scenarioId: string,
): ExactSummary | undefined {
  return exactResults.find(
    (result) =>
      result.scenario === scenarioId &&
      result.modelId === baselineId &&
      result.status === "completed",
  );
}

export function incompleteBaselineForScenario(
  exactResults: readonly ExactSummary[],
  baselineId: string,
  scenarioId: string,
): ExactSummary | undefined {
  return exactResults.find(
    (result) =>
      result.scenario === scenarioId &&
      result.modelId === baselineId &&
      result.status !== "completed",
  );
}

export function trajectoryJobSummary(
  result: TrajectoryEvaluation,
  metrics: MetricsModule,
): TrajectoryJobSummary {
  if (result.status !== "completed") {
    return {
      status: result.status,
      reason: result.reason,
      scenario: result.scenario.id,
      modelId: result.modelId,
      seed: result.seed,
      runsCompleted: result.runsCompleted,
      elapsedMs: result.elapsedMs,
      solveCalls: result.solveCalls,
      cachedPolicies: result.cachedPolicies,
    };
  }
  return {
    status: "completed",
    scenario: result.scenario.id,
    modelId: result.modelId,
    seed: result.seed,
    runs: result.runs,
    elapsedMs: result.elapsedMs,
    solveCalls: result.solveCalls,
    cachedPolicies: result.cachedPolicies,
    summary: metrics.summarizeTrajectories(result.samples),
  };
}

export async function writeDeepSliceOutputs(
  state: DeepSliceState,
  baselineId: string,
  files: { outputFile: URL; checkpointFile: URL },
) {
  const report = {
    kind: "availability-deep-slice",
    version: 1,
    generatedAt: new Date().toISOString(),
    config: state.config,
    phase: state.phase,
    exactJobIndex: state.exactJobIndex,
    finiteTailJobIndex: state.finiteTailJobIndex,
    journeyTailJobIndex: state.journeyTailJobIndex,
    exactResults: withExactLosses(state.exactResults, baselineId),
    finiteStockTail: state.finiteStockTail,
    journeyDemand: aggregateJourneyDemand(state.journeyTail),
  };
  await writeFile(files.outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(files.checkpointFile, `${JSON.stringify(state)}\n`, "utf8");
  return report;
}

function isCompletedExactSummary(
  result: ExactSummary,
): result is ExactSummary & { status: "completed"; successProbability: number } {
  return result.status === "completed" && typeof result.successProbability === "number";
}

function withExactLosses(
  exactResults: readonly ExactSummary[],
  baselineId: string,
): ExactSummary[] {
  const baselineByScenario = new Map<string, number>();
  for (const result of exactResults) {
    if (result.modelId === baselineId && isCompletedExactSummary(result)) {
      baselineByScenario.set(result.scenario, result.successProbability);
    }
  }
  return exactResults.map((result) => {
    if (!isCompletedExactSummary(result)) return result;
    const baselineP = baselineByScenario.get(result.scenario);
    return {
      ...result,
      exactLossVsA: typeof baselineP === "number" ? baselineP - result.successProbability : null,
      relativeLossVsA:
        typeof baselineP === "number" && baselineP > 0
          ? (baselineP - result.successProbability) / baselineP
          : null,
    };
  });
}

function isCompletedJourneyPanel(panel: JourneyPanelSummary): panel is Extract<
  TrajectoryJobSummary,
  { status: "completed" }
> & {
  supplyDebtStatus: "completed";
} {
  return panel.status === "completed" && panel.supplyDebtStatus === "completed";
}

function aggregateJourneyDemand(
  journeyTail: readonly TrajectoryJobSummary[],
): JourneyDemandSummary[] {
  const grouped = new Map<string, JourneyDemandSummary>();
  for (const result of journeyTail) {
    const entry = grouped.get(result.modelId) || {
      candidateId: result.modelId,
      panels: [],
      maxPanelSupplyDebtCvar90: null,
    };
    const supplyDebtStatus: JourneyPanelSummary["supplyDebtStatus"] =
      result.status === "completed" && result.summary.completionRate >= 0.995
        ? "completed"
        : "judgement_incomplete";
    entry.panels.push({ ...result, supplyDebtStatus });
    grouped.set(result.modelId, entry);
  }
  return Array.from(grouped.values()).map((entry) => {
    const completedPanelDebtValues = entry.panels
      .filter(isCompletedJourneyPanel)
      .map((panel) => panel.summary.maxSupplyDebtDaysCvar90);
    return {
      ...entry,
      maxPanelSupplyDebtCvar90:
        completedPanelDebtValues.length > 0 ? Math.max(...completedPanelDebtValues) : null,
    };
  });
}
