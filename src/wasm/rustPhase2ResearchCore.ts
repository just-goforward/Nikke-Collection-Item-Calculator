import {
  phase2BuildContext,
  readPhase2Root,
  readRootCandidates,
  solvePhase2Slot,
} from "./rustCoreShared";
import {
  estimateA2SurrogateAfterFirstActionFromCurrent,
  estimateExactExpectedCostAfterFirstActionFromCurrent,
  estimateExpectedCostAfterFirstAction,
  estimateExpectedCostAfterFirstActionFromCurrent,
  estimateExpectedCostAfterFirstActionFromCurrentWithMoments,
  estimateExpectedCostPairFromCurrent,
} from "./rustPhase2ExpectedCost";
import {
  actionAtForPhase2Generation,
  type Phase2FactoryState,
  recordPhase2Build,
} from "./rustPhase2PolicyState";
import { simulatePolicy, simulatePolicyAfterFirstAction } from "./rustPhase2Validation";
import type {
  RustCoreExports,
  RustPhase2Policy,
  RustPhase2Solver,
  State,
  Stock,
} from "./rustTypes";

// Research-only phase2 wrapper. This keeps A2 covariance surrogate, paired MC rerank,
// and exact E[f] probes available to benchmarks without pulling them into product paths.
function buildPolicy(
  state: Phase2FactoryState,
  start: State,
  stock: Stock,
  horizonFactor = 0.75,
  normPower = 3,
  tolerance = 0,
): RustPhase2Policy {
  const context = phase2BuildContext(start, stock, horizonFactor, normPower, tolerance);
  const slot = solvePhase2Slot(state.exports, start, stock, horizonFactor, normPower, tolerance);
  const generation = recordPhase2Build(state, context);
  return {
    root: readPhase2Root(state.exports, slot),
    candidates: readRootCandidates(state.exports, tolerance),
    actionAt(nodeState, stockUses) {
      return actionAtForPhase2Generation(state, generation, nodeState, stockUses);
    },
  };
}

function rootCandidates(
  state: Phase2FactoryState,
  start: State,
  stock: Stock,
  horizonFactor = 0.75,
  normPower = 3,
  tolerance = 0,
) {
  const context = phase2BuildContext(start, stock, horizonFactor, normPower, tolerance);
  solvePhase2Slot(state.exports, start, stock, horizonFactor, normPower, tolerance);
  recordPhase2Build(state, context);
  return readRootCandidates(state.exports, tolerance);
}

export function createRustPhase2ResearchSolver(exports: RustCoreExports): RustPhase2Solver {
  exports.configureMemo?.(21);
  exports.configureNodeBudget?.(0);
  const state: Phase2FactoryState = {
    buildGeneration: 0,
    currentBuild: null,
    exports,
    memoTier: 21,
  };
  return {
    configureMemoTier(tier) {
      const memoTier = Math.min(24, Math.max(16, Math.floor(tier)));
      exports.configureMemo?.(memoTier);
      state.memoTier = memoTier;
      state.currentBuild = null;
      state.buildGeneration += 1;
    },
    memoTier: () => state.memoTier,
    releaseMemo() {
      exports.releasePhase2Memo?.();
      state.currentBuild = null;
      state.buildGeneration += 1;
    },
    buildPolicy: (...args) => buildPolicy(state, ...args),
    solveRoot: (...args) => buildPolicy(state, ...args).root,
    rootCandidates: (...args) => rootCandidates(state, ...args),
    estimateExpectedCostAfterFirstAction: (...args) =>
      estimateExpectedCostAfterFirstAction(state, ...args),
    estimateExpectedCostAfterFirstActionFromCurrent: (...args) =>
      estimateExpectedCostAfterFirstActionFromCurrent(state, ...args),
    estimateExpectedCostAfterFirstActionFromCurrentWithMoments: (...args) =>
      estimateExpectedCostAfterFirstActionFromCurrentWithMoments(state, ...args),
    estimateExpectedCostPairFromCurrent: (...args) =>
      estimateExpectedCostPairFromCurrent(state, ...args),
    estimateA2SurrogateAfterFirstActionFromCurrent: (...args) =>
      estimateA2SurrogateAfterFirstActionFromCurrent(state, ...args),
    estimateExactExpectedCostAfterFirstActionFromCurrent: (...args) =>
      estimateExactExpectedCostAfterFirstActionFromCurrent(state, ...args),
    simulatePolicy: (...args) => simulatePolicy(state, ...args),
    simulatePolicyAfterFirstAction: (...args) => simulatePolicyAfterFirstAction(state, ...args),
    selectFirstActionByExpectedCost(
      start,
      stock,
      runs,
      seed,
      horizonFactor = 0.75,
      normPower = 3,
      tolerance = 0,
    ) {
      const policy = buildPolicy(state, start, stock, horizonFactor, normPower, tolerance);
      const exactCandidates = policy.candidates.filter((candidate) => candidate.eligible);
      if (exactCandidates.length === 0) return null;
      const candidates = exactCandidates.map((candidate) => ({
        ...candidate,
        ...estimateExpectedCostAfterFirstActionFromCurrent(
          state,
          start,
          stock,
          candidate.firstAction,
          runs,
          seed,
          horizonFactor,
          normPower,
        ),
      }));
      const selected = selectLowestExpectedCostCandidate(candidates);
      return { baseline: policy.root, selected, candidates, policy };
    },
  };
}

function selectLowestExpectedCostCandidate<
  T extends { expectedCost: number; resourceCost: number; successProbability: number },
>(candidates: T[]) {
  return candidates.reduce((best, candidate) => {
    const expectedCostDelta = candidate.expectedCost - best.expectedCost;
    if (Math.abs(expectedCostDelta) > 1e-12) return expectedCostDelta < 0 ? candidate : best;
    const resourceCostDelta = candidate.resourceCost - best.resourceCost;
    if (Math.abs(resourceCostDelta) > 1e-12) return resourceCostDelta < 0 ? candidate : best;
    return candidate.successProbability > best.successProbability ? candidate : best;
  });
}
