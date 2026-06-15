import {
  RUST_PRODUCT_HORIZON_FACTOR,
  RUST_PRODUCT_NORM_POWER,
  RUST_PRODUCT_TOLERANCE,
  RUST_RERANK_FULL_ACCEPT_MARGIN,
  RUST_RERANK_GATE_Z,
  RUST_RERANK_HELD_OUT_SEED,
  RUST_RERANK_MAX_RUNS,
  RUST_RERANK_QUICK_ACCEPT_MARGIN,
  RUST_RERANK_QUICK_RUNS,
  RUST_RERANK_SEED,
} from "./rustProductConfig";
import type { RustProductInput } from "./rustProductInput";
import type {
  RustPairedExpectedCostEstimate,
  RustPhase2Solver,
  RustRerankedCandidate,
  RustRerankResult,
} from "./rustTypes";

export type AdaptiveRerankDecision = {
  rerank: RustRerankResult;
  rawSelected: RustRerankedCandidate;
  selected: RustRerankedCandidate;
  gatePair: RustPairedExpectedCostEstimate | null;
  gatePass: boolean;
  gateRuns: number;
  gateUpperBound: number | null;
};

function baselineRerankCandidate(
  solver: RustPhase2Solver,
  rerank: RustRerankResult,
  input: RustProductInput,
): RustRerankedCandidate | null {
  const firstAction = rerank.baseline.firstAction;
  if (!firstAction) return null;
  const existing = rerank.candidates.find((candidate) => candidate.firstAction === firstAction);
  if (existing) return existing;
  const estimate = solver.estimateExpectedCostAfterFirstActionFromCurrent(
    input.start,
    input.stock,
    firstAction,
    RUST_RERANK_QUICK_RUNS,
    RUST_RERANK_SEED,
    RUST_PRODUCT_HORIZON_FACTOR,
    RUST_PRODUCT_NORM_POWER,
  );
  return {
    firstAction,
    successProbability: rerank.baseline.successProbability,
    maxSuccessProbability: rerank.baseline.maxSuccessProbability,
    probabilityGap: Math.max(
      0,
      rerank.baseline.maxSuccessProbability - rerank.baseline.successProbability,
    ),
    vector: rerank.baseline.vector,
    resourceCost: estimate.expectedCost,
    eligible: true,
    expectedCost: estimate.expectedCost,
    completionRate: estimate.completionRate,
  };
}

export function selectAdaptiveRerankDecision(
  solver: RustPhase2Solver,
  input: RustProductInput,
): AdaptiveRerankDecision | null {
  const rerank = solver.selectFirstActionByExpectedCost(
    input.start,
    input.stock,
    RUST_RERANK_QUICK_RUNS,
    RUST_RERANK_SEED,
    RUST_PRODUCT_HORIZON_FACTOR,
    RUST_PRODUCT_NORM_POWER,
    RUST_PRODUCT_TOLERANCE,
  );
  const rawSelected = rerank?.selected;
  const baselineAction = rerank?.baseline.firstAction;
  if (!rerank || !rawSelected?.firstAction || !baselineAction) return null;
  if (baselineAction === rawSelected.firstAction) {
    return {
      rerank,
      rawSelected,
      selected: rawSelected,
      gatePair: null,
      gatePass: true,
      gateRuns: 0,
      gateUpperBound: null,
    };
  }
  const quickGatePair = solver.estimateExpectedCostPairFromCurrent(
    input.start,
    input.stock,
    baselineAction,
    rawSelected.firstAction,
    RUST_RERANK_QUICK_RUNS,
    RUST_RERANK_HELD_OUT_SEED,
    RUST_PRODUCT_HORIZON_FACTOR,
    RUST_PRODUCT_NORM_POWER,
  );
  const quickUpperBound =
    quickGatePair.meanDelta + RUST_RERANK_GATE_Z * quickGatePair.standardError;
  if (quickUpperBound < RUST_RERANK_QUICK_ACCEPT_MARGIN) {
    return {
      rerank,
      rawSelected,
      selected: rawSelected,
      gatePair: quickGatePair,
      gatePass: true,
      gateRuns: RUST_RERANK_QUICK_RUNS,
      gateUpperBound: quickUpperBound,
    };
  }
  const quickLowerBound =
    quickGatePair.meanDelta - RUST_RERANK_GATE_Z * quickGatePair.standardError;
  const fullGatePair =
    quickLowerBound >= 0
      ? quickGatePair
      : solver.estimateExpectedCostPairFromCurrent(
          input.start,
          input.stock,
          baselineAction,
          rawSelected.firstAction,
          RUST_RERANK_MAX_RUNS,
          RUST_RERANK_HELD_OUT_SEED,
          RUST_PRODUCT_HORIZON_FACTOR,
          RUST_PRODUCT_NORM_POWER,
        );
  const gateUpperBound = fullGatePair.meanDelta + RUST_RERANK_GATE_Z * fullGatePair.standardError;
  const gatePass = gateUpperBound < RUST_RERANK_FULL_ACCEPT_MARGIN;
  if (gatePass) {
    return {
      rerank,
      rawSelected,
      selected: rawSelected,
      gatePair: fullGatePair,
      gatePass,
      gateRuns: fullGatePair.runs,
      gateUpperBound,
    };
  }
  const baseline = baselineRerankCandidate(solver, rerank, input);
  if (!baseline) return null;
  return {
    rerank,
    rawSelected,
    selected: baseline,
    gatePair: fullGatePair,
    gatePass,
    gateRuns: fullGatePair.runs,
    gateUpperBound,
  };
}
