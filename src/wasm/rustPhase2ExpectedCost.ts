import type { Kit } from "../types";
import { estimateA2SurrogateFromBuiltPolicy } from "./rustA2Surrogate";
import {
  actionToIndex,
  encodeState,
  phase2BuildContext,
  populationVariance,
  requireExport,
  stockToUses,
} from "./rustCoreShared";
import { assertCurrentPhase2Build, type Phase2FactoryState } from "./rustPhase2PolicyState";
import { assertRustStatusOk } from "./rustStatus";
import type {
  RustA2MomentEstimate,
  RustExactExpectedCostEstimate,
  RustFirstActionEstimate,
  RustFirstActionMomentEstimate,
  RustPairedExpectedCostEstimate,
  State,
  Stock,
} from "./rustTypes";

function runPolicyExpectedCostRollout(
  state: Phase2FactoryState,
  start: State,
  stock: Stock,
  firstAction: Kit,
  runs: number,
  seed: number,
  horizonFactor: number,
  normPower: number,
) {
  assertCurrentPhase2Build(
    state,
    phase2BuildContext(start, stock, horizonFactor, normPower, 0),
    "current-policy first-action E[f] rollout",
    { compareTolerance: false },
  );
  const simulate = requireExport(state.exports, "simulateExpectedFAfterFirstActionFromPolicy");
  const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
  const stockUses = stockToUses(stock);
  simulate(
    stateId,
    stockUses.blue | 0,
    stockUses.purple | 0,
    stockUses.yellow | 0,
    stock.blue | 0,
    stock.purple | 0,
    stock.yellow | 0,
    horizonFactor,
    normPower,
    Math.max(0, Math.floor(runs) || 0),
    seed >>> 0,
    actionToIndex(firstAction),
  );
  assertRustStatusOk(state.exports, "phase2 first-action E[f] rollout");
}

export function estimateExpectedCostAfterFirstActionFromCurrentWithMoments(
  state: Phase2FactoryState,
  start: State,
  stock: Stock,
  firstAction: Kit,
  runs: number,
  seed: number,
  horizonFactor = 0.75,
  normPower = 3,
): RustFirstActionMomentEstimate {
  runPolicyExpectedCostRollout(
    state,
    start,
    stock,
    firstAction,
    runs,
    seed,
    horizonFactor,
    normPower,
  );
  const expectedCost = requireExport(state.exports, "getMcEf")();
  const actualRuns = requireExport(state.exports, "getMcEfRuns")();
  const sumSq = requireExport(state.exports, "getMcEfSumSq")();
  const variance = populationVariance(sumSq, expectedCost, actualRuns);
  return {
    expectedCost,
    completionRate: requireExport(state.exports, "getMcEfCompletion")(),
    runs: actualRuns,
    sumSq,
    variance,
    standardError: actualRuns > 0 ? Math.sqrt(variance / actualRuns) : 0,
  };
}

export function estimateExpectedCostAfterFirstActionFromCurrent(
  state: Phase2FactoryState,
  start: State,
  stock: Stock,
  firstAction: Kit,
  runs: number,
  seed: number,
  horizonFactor = 0.75,
  normPower = 3,
): RustFirstActionEstimate {
  const estimate = estimateExpectedCostAfterFirstActionFromCurrentWithMoments(
    state,
    start,
    stock,
    firstAction,
    runs,
    seed,
    horizonFactor,
    normPower,
  );
  return {
    expectedCost: estimate.expectedCost,
    completionRate: estimate.completionRate,
  };
}

export function estimateExpectedCostPairFromCurrent(
  state: Phase2FactoryState,
  start: State,
  stock: Stock,
  baselineFirstAction: Kit,
  selectedFirstAction: Kit,
  runs: number,
  seed: number,
  horizonFactor = 0.75,
  normPower = 3,
): RustPairedExpectedCostEstimate {
  assertCurrentPhase2Build(
    state,
    phase2BuildContext(start, stock, horizonFactor, normPower, 0),
    "current-policy paired E[f] rollout",
    { compareTolerance: false },
  );
  simulateExpectedCostPair(
    state,
    start,
    stock,
    baselineFirstAction,
    selectedFirstAction,
    runs,
    seed,
    horizonFactor,
    normPower,
  );
  const actualRuns = requireExport(state.exports, "getPairRuns")();
  const meanDelta = requireExport(state.exports, "getPairMeanDelta")();
  const deltaSumSq = requireExport(state.exports, "getPairDeltaSumSq")();
  const deltaVariance = populationVariance(deltaSumSq, meanDelta, actualRuns);
  const standardError = actualRuns > 0 ? Math.sqrt(deltaVariance / actualRuns) : 0;
  return {
    runs: actualRuns,
    meanBaseline: requireExport(state.exports, "getPairMeanBaseline")(),
    meanSelected: requireExport(state.exports, "getPairMeanSelected")(),
    meanDelta,
    deltaSumSq,
    deltaVariance,
    standardError,
    upper95: meanDelta + 1.96 * standardError,
    correlation: requireExport(state.exports, "getPairCorrelation")(),
  };
}

function simulateExpectedCostPair(
  state: Phase2FactoryState,
  start: State,
  stock: Stock,
  baselineFirstAction: Kit,
  selectedFirstAction: Kit,
  runs: number,
  seed: number,
  horizonFactor: number,
  normPower: number,
) {
  const simulate = requireExport(state.exports, "simulateExpectedFPairFromPolicy");
  const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
  const stockUses = stockToUses(stock);
  simulate(
    stateId,
    stockUses.blue | 0,
    stockUses.purple | 0,
    stockUses.yellow | 0,
    stock.blue | 0,
    stock.purple | 0,
    stock.yellow | 0,
    horizonFactor,
    normPower,
    Math.max(0, Math.floor(runs) || 0),
    seed >>> 0,
    actionToIndex(baselineFirstAction),
    actionToIndex(selectedFirstAction),
  );
  assertRustStatusOk(state.exports, "phase2 paired E[f] rollout");
}

export function estimateA2SurrogateAfterFirstActionFromCurrent(
  state: Phase2FactoryState,
  start: State,
  stock: Stock,
  firstAction: Kit,
  horizonFactor = 0.75,
  normPower = 3,
): RustA2MomentEstimate {
  assertCurrentPhase2Build(
    state,
    phase2BuildContext(start, stock, horizonFactor, normPower, 0),
    "current-policy A2 moment rollout",
    { compareTolerance: false },
  );
  return estimateA2SurrogateFromBuiltPolicy(
    state.exports,
    start,
    stock,
    firstAction,
    horizonFactor,
    normPower,
  );
}

export function estimateExactExpectedCostAfterFirstActionFromCurrent(
  state: Phase2FactoryState,
  start: State,
  stock: Stock,
  firstAction: Kit,
  horizonFactor = 0.75,
  normPower = 3,
): RustExactExpectedCostEstimate {
  assertCurrentPhase2Build(
    state,
    phase2BuildContext(start, stock, horizonFactor, normPower, 0),
    "current-policy exact E[f] rollout",
    { compareTolerance: false },
  );
  const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
  requireExport(state.exports, "cvarSetup")(
    stateId,
    stock.blue | 0,
    stock.purple | 0,
    stock.yellow | 0,
    horizonFactor,
    normPower,
    state.currentBuild?.tolerance ?? 0,
  );
  assertRustStatusOk(state.exports, "phase2 exact E[f] setup");
  const expectedCost = requireExport(
    state.exports,
    "cvarFollowMeanAfterFirstAction",
  )(actionToIndex(firstAction));
  assertRustStatusOk(state.exports, "phase2 exact E[f] rollout");
  return {
    expectedCost,
    nodeCount: requireExport(state.exports, "cvarNodeCount")(),
  };
}

export function estimateExpectedCostAfterFirstAction(
  state: Phase2FactoryState,
  start: State,
  stock: Stock,
  firstAction: Kit,
  runs: number,
  seed: number,
  horizonFactor = 0.75,
  normPower = 3,
  tolerance = 0,
): RustFirstActionEstimate {
  const simulate = requireExport(state.exports, "simulateExpectedFAfterFirstAction");
  const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
  const stockUses = stockToUses(stock);
  simulate(
    stateId,
    stockUses.blue | 0,
    stockUses.purple | 0,
    stockUses.yellow | 0,
    stock.blue | 0,
    stock.purple | 0,
    stock.yellow | 0,
    horizonFactor,
    normPower,
    tolerance,
    Math.max(0, Math.floor(runs) || 0),
    seed >>> 0,
    actionToIndex(firstAction),
  );
  assertRustStatusOk(state.exports, "phase2 first-action E[f] simulation");
  return {
    expectedCost: requireExport(state.exports, "getMcEf")(),
    completionRate: requireExport(state.exports, "getMcEfCompletion")(),
  };
}
