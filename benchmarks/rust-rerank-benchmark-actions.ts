import type { Kit } from "../src/types";
import type { RustPhase2ResearchSolver } from "../src/wasm/rustTypes";
import {
  ADAPTIVE_FULL_ACCEPT_MARGIN,
  ADAPTIVE_GATE_Z,
  ADAPTIVE_MAX_RUNS,
  ADAPTIVE_QUICK_ACCEPT_MARGIN,
  ADAPTIVE_QUICK_RUNS,
  type Adaptive90Decision,
  type BenchmarkScenario,
  calculateAdaptiveGateUpperBound,
  HORIZON_FACTOR,
  NORM_POWER,
  nullAdaptive90Decision,
  summarizeEvaluationPairs,
  TOLERANCE,
} from "./rust-rerank-benchmark-utils.ts";
import { RUST_RERANK_STRICT_EPSILON as STRICT_EPSILON } from "./rust-rerank-summary-model.ts";

export type CostComparison = {
  baselineCost: number | null;
  selectedCost: number | null;
  deltaVsBaseline: number | null;
  nodeCount: number | null;
  errorMessage: string | null;
};

export function evaluateAdaptive90Gate(args: {
  solver: RustPhase2ResearchSolver;
  scenario: BenchmarkScenario;
  seed: number;
  heldOutSeed: number;
  evaluationSeeds: readonly number[];
}): Adaptive90Decision {
  const adaptiveRerank = args.solver.selectFirstActionByExpectedCost(
    args.scenario.start,
    args.scenario.stock,
    ADAPTIVE_QUICK_RUNS,
    args.seed,
    HORIZON_FACTOR,
    NORM_POWER,
    TOLERANCE,
  );
  const adaptiveBaselineAction = adaptiveRerank?.baseline.firstAction;
  const adaptiveRawSelectedAction = adaptiveRerank?.selected.firstAction;
  if (!adaptiveBaselineAction || !adaptiveRawSelectedAction) return nullAdaptive90Decision();
  if (adaptiveBaselineAction === adaptiveRawSelectedAction) {
    return {
      rawSelectedFirstAction: adaptiveRawSelectedAction,
      selectedFirstAction: adaptiveBaselineAction,
      gatePass: true,
      intervened: false,
      evaluationDeltaVsBaseline: 0,
      falsePositive: false,
      falseNegative: false,
      gateRuns: 0,
      gateMeanDelta: null,
      gateStandardError: null,
      gateUpperBound: null,
      gateCorrelation: null,
    };
  }

  const quickPair = estimatePair(args, adaptiveBaselineAction, adaptiveRawSelectedAction);
  let gatePair = quickPair;
  let gateRuns = ADAPTIVE_QUICK_RUNS;
  let gateUpperBound = calculateAdaptiveGateUpperBound(quickPair);
  let gatePass = gateUpperBound < ADAPTIVE_QUICK_ACCEPT_MARGIN;
  const quickLowerBound = quickPair.meanDelta - ADAPTIVE_GATE_Z * quickPair.standardError;
  if (!gatePass && quickLowerBound < 0) {
    gatePair = estimatePair(args, adaptiveBaselineAction, adaptiveRawSelectedAction, {
      runs: ADAPTIVE_MAX_RUNS,
    });
    gateRuns = ADAPTIVE_MAX_RUNS;
    gateUpperBound = calculateAdaptiveGateUpperBound(gatePair);
    gatePass = gateUpperBound < ADAPTIVE_FULL_ACCEPT_MARGIN;
  }

  const adaptiveEvaluation = summarizeEvaluationPairs(
    args.evaluationSeeds.map((evaluationSeed) =>
      args.solver.estimateExpectedCostPairFromCurrent(
        args.scenario.start,
        args.scenario.stock,
        adaptiveBaselineAction,
        adaptiveRawSelectedAction,
        ADAPTIVE_MAX_RUNS,
        evaluationSeed,
        HORIZON_FACTOR,
        NORM_POWER,
      ),
    ),
  );
  const evaluationSelectedImproves = adaptiveEvaluation.meanDelta < -STRICT_EPSILON;
  const evaluationSelectedWorsens = adaptiveEvaluation.meanDelta > STRICT_EPSILON;
  return {
    rawSelectedFirstAction: adaptiveRawSelectedAction,
    selectedFirstAction: gatePass ? adaptiveRawSelectedAction : adaptiveBaselineAction,
    gatePass,
    intervened: gatePass,
    evaluationDeltaVsBaseline: gatePass ? adaptiveEvaluation.meanDelta : 0,
    falsePositive: gatePass ? evaluationSelectedWorsens : false,
    falseNegative: !gatePass ? evaluationSelectedImproves : false,
    gateRuns,
    gateMeanDelta: gatePair.meanDelta,
    gateStandardError: gatePair.standardError,
    gateUpperBound,
    gateCorrelation: gatePair.correlation,
  };
}

export function compareA2ForActions(args: {
  solver: RustPhase2ResearchSolver;
  scenario: BenchmarkScenario;
  baselineFirstAction: Kit;
  selectedFirstAction: Kit;
}): CostComparison {
  try {
    const selected = args.solver.estimateA2SurrogateAfterFirstActionFromCurrent(
      args.scenario.start,
      args.scenario.stock,
      args.selectedFirstAction,
      HORIZON_FACTOR,
      NORM_POWER,
    );
    const baseline =
      args.baselineFirstAction === args.selectedFirstAction
        ? selected
        : args.solver.estimateA2SurrogateAfterFirstActionFromCurrent(
            args.scenario.start,
            args.scenario.stock,
            args.baselineFirstAction,
            HORIZON_FACTOR,
            NORM_POWER,
          );
    return {
      baselineCost: baseline.surrogateCost,
      selectedCost: selected.surrogateCost,
      deltaVsBaseline: selected.surrogateCost - baseline.surrogateCost,
      nodeCount: Math.max(baseline.nodeCount, selected.nodeCount),
      errorMessage: null,
    };
  } catch (error) {
    return nullCostComparison(error);
  }
}

export function compareA1ForActions(args: {
  solver: RustPhase2ResearchSolver;
  scenario: BenchmarkScenario;
  baselineFirstAction: Kit;
  selectedFirstAction: Kit;
  enabled: boolean;
}): CostComparison {
  if (!args.enabled) return nullCostComparison();
  try {
    const selected = args.solver.estimateExactExpectedCostAfterFirstActionFromCurrent(
      args.scenario.start,
      args.scenario.stock,
      args.selectedFirstAction,
      HORIZON_FACTOR,
      NORM_POWER,
    );
    const baseline =
      args.baselineFirstAction === args.selectedFirstAction
        ? selected
        : args.solver.estimateExactExpectedCostAfterFirstActionFromCurrent(
            args.scenario.start,
            args.scenario.stock,
            args.baselineFirstAction,
            HORIZON_FACTOR,
            NORM_POWER,
          );
    return {
      baselineCost: baseline.expectedCost,
      selectedCost: selected.expectedCost,
      deltaVsBaseline: selected.expectedCost - baseline.expectedCost,
      nodeCount: Math.max(baseline.nodeCount, selected.nodeCount),
      errorMessage: null,
    };
  } catch (error) {
    return nullCostComparison(error);
  }
}

function estimatePair(
  args: {
    solver: RustPhase2ResearchSolver;
    scenario: BenchmarkScenario;
    heldOutSeed: number;
  },
  baselineFirstAction: Kit,
  selectedFirstAction: Kit,
  options: { runs?: number } = {},
) {
  return args.solver.estimateExpectedCostPairFromCurrent(
    args.scenario.start,
    args.scenario.stock,
    baselineFirstAction,
    selectedFirstAction,
    options.runs ?? ADAPTIVE_QUICK_RUNS,
    args.heldOutSeed,
    HORIZON_FACTOR,
    NORM_POWER,
  );
}

function nullCostComparison(error?: unknown): CostComparison {
  return {
    baselineCost: null,
    selectedCost: null,
    deltaVsBaseline: null,
    nodeCount: null,
    errorMessage:
      error instanceof Error ? error.message : error === undefined ? null : String(error),
  };
}
