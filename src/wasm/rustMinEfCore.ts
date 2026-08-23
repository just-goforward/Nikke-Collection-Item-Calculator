import { clampMemoStockUses } from "../solver/domain";
import {
  actionFromIndex,
  activeSupplyForecastContext,
  encodeState,
  readMinEfRootCandidates,
  validateSupplyForecastContext,
} from "./rustCoreShared";
import { RUST_MIN_EF_MEMO_TIER } from "./rustProductConfig";
import { assertRustStatusOk, RUST_STATUS_OK, RustSolveError } from "./rustStatus";
import type {
  RustCoreExports,
  RustMinEfPolicyHandle,
  RustMinEfRoot,
  RustMinEfSolver,
  State,
  Stock,
  SupplyForecastContext,
} from "./rustTypes";

const RUST_MIN_EF_NODE_BUDGET = 2_000_000;

type MinEfFactoryState = {
  buildGeneration: number;
  exports: RustCoreExports;
  memoTier: number;
  supplyForecast: SupplyForecastContext;
};

export function createRustMinEfSolver(exports: RustCoreExports): RustMinEfSolver {
  exports.configureMemo?.(21);
  exports.configureMinEfMemo?.(RUST_MIN_EF_MEMO_TIER);
  exports.configureNodeBudget?.(RUST_MIN_EF_NODE_BUDGET);
  const state: MinEfFactoryState = {
    buildGeneration: 0,
    exports,
    memoTier: RUST_MIN_EF_MEMO_TIER,
    supplyForecast: activeSupplyForecastContext(),
  };
  return {
    setSupplyForecast: (context) => setSupplyForecast(state, context),
    configureMemoTier: (tier) => configureMinEfMemoTier(state, tier),
    memoTier: () => state.memoTier,
    releaseMemo: () => releaseMemo(state),
    solveRootWithCandidates: (start, stock, horizonFactor = 0.75, normPower = 3, tolerance = 0) =>
      solveMinEfRootWithCandidates(state, start, stock, horizonFactor, normPower, tolerance),
  };
}

function setSupplyForecast(state: MinEfFactoryState, context: SupplyForecastContext) {
  state.supplyForecast = validateSupplyForecastContext(context);
  state.exports.releaseMinEfMemo?.();
  state.buildGeneration += 1;
}

function configureMinEfMemoTier(state: MinEfFactoryState, tier: number) {
  const normalizedTier = Math.min(22, Math.max(18, Math.floor(tier)));
  state.exports.configureMinEfMemo?.(normalizedTier);
  state.memoTier = normalizedTier;
  state.buildGeneration += 1;
}

function releaseMemo(state: MinEfFactoryState) {
  state.exports.releaseMinEfMemo?.();
  state.buildGeneration += 1;
}

function runMinEf(
  exports: RustCoreExports,
  start: State,
  stock: Stock,
  horizonFactor: number,
  normPower: number,
  tolerance: number,
  supplyForecast: SupplyForecastContext,
) {
  const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
  // Raw pieces define availability-cost denominators.
  // WASM independently caps derived uses for memo keys.
  exports.solveMinEf(
    stateId,
    stock.blue | 0,
    stock.purple | 0,
    stock.yellow | 0,
    supplyForecast.expectedGain.blue,
    supplyForecast.expectedGain.purple,
    supplyForecast.expectedGain.yellow,
    horizonFactor,
    normPower,
    tolerance,
  );
}

function solveMinEfRootWithCandidates(
  state: MinEfFactoryState,
  start: State,
  stock: Stock,
  horizonFactor: number,
  normPower: number,
  tolerance: number,
): RustMinEfPolicyHandle {
  const exports = state.exports;
  runMinEf(exports, start, stock, horizonFactor, normPower, tolerance, state.supplyForecast);
  assertMinEfRootStatusOk(exports);
  state.buildGeneration += 1;
  const generation = state.buildGeneration;
  const root = readMinEfRoot(exports);
  return {
    root,
    candidates: readMinEfRootCandidates(exports, tolerance),
    nodeCount: root.states,
    actionAt(nodeState, stockUses) {
      assertMinEfPolicyGeneration(state, generation);
      return lookupMinEfAction(exports, nodeState, stockUses);
    },
  };
}

function assertMinEfRootStatusOk(exports: RustCoreExports) {
  const status = exports.getSolveStatus?.() ?? RUST_STATUS_OK;
  if (status === RUST_STATUS_OK) return;
  throw new RustSolveError("root solve", status, "status", exports.minEfNodeCount?.() ?? null);
}

function readMinEfRoot(exports: RustCoreExports): RustMinEfRoot {
  return {
    expectedCost: exports.minEfExpectedCost(),
    firstAction: actionFromIndex(exports.minEfAction()),
    maxSuccessProbability: exports.minEfMaxSuccessProb(),
    successProbability: exports.minEfSuccessProb(),
    states: exports.minEfNodeCount?.() ?? 0,
    vector: {
      blue: exports.minEfVecB(),
      purple: exports.minEfVecP(),
      yellow: exports.minEfVecY(),
    },
  };
}

function lookupMinEfAction(exports: RustCoreExports, state: State, stockUses: Stock) {
  const stateId = encodeState(state.grade, state.level, state.exp ?? 0);
  const boundedStock = clampMemoStockUses(stockUses);
  const action = exports.minEfActionAtOrSolve(
    stateId,
    boundedStock.blue | 0,
    boundedStock.purple | 0,
    boundedStock.yellow | 0,
  );
  assertRustStatusOk(exports, "action lookup");
  return actionFromIndex(action);
}

function assertMinEfPolicyGeneration(state: MinEfFactoryState, generation: number) {
  if (generation === state.buildGeneration) return;
  throw new RustSolveError("min-E[f] policy", null, "stale_handle");
}
