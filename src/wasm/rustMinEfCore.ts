import { actionFromIndex, encodeState, readMinEfRootCandidates } from "./rustCoreShared";
import { assertRustStatusOk } from "./rustStatus";
import type { RustCoreExports, RustMinEfSolver, State, Stock } from "./rustTypes";

const RUST_MIN_EF_NODE_BUDGET = 2_000_000;

export function createRustMinEfSolver(exports: RustCoreExports): RustMinEfSolver {
  exports.configureMemo?.(21);
  exports.configureNodeBudget?.(RUST_MIN_EF_NODE_BUDGET);
  return {
    actionAt: (state, stockUses) => lookupMinEfAction(exports, state, stockUses),
    rootCandidates: (start, stock, horizonFactor = 0.75, normPower = 3, tolerance = 0) =>
      solveMinEfCandidates(exports, start, stock, horizonFactor, normPower, tolerance),
    solveRoot: (start, stock, horizonFactor = 0.75, normPower = 3, tolerance = 0) =>
      solveMinEfRoot(exports, start, stock, horizonFactor, normPower, tolerance),
  };
}

function runMinEf(
  exports: RustCoreExports,
  start: State,
  stock: Stock,
  horizonFactor: number,
  normPower: number,
  tolerance: number,
) {
  const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
  exports.solveMinEf(
    stateId,
    stock.blue | 0,
    stock.purple | 0,
    stock.yellow | 0,
    horizonFactor,
    normPower,
    tolerance,
  );
}

function solveMinEfRoot(
  exports: RustCoreExports,
  start: State,
  stock: Stock,
  horizonFactor: number,
  normPower: number,
  tolerance: number,
) {
  runMinEf(exports, start, stock, horizonFactor, normPower, tolerance);
  assertRustStatusOk(exports, "root solve");
  return {
    expectedCost: exports.minEfExpectedCost(),
    firstAction: actionFromIndex(exports.minEfAction()),
    maxSuccessProbability: exports.minEfMaxSuccessProb(),
    successProbability: exports.minEfSuccessProb(),
    vector: {
      blue: exports.minEfVecB(),
      purple: exports.minEfVecP(),
      yellow: exports.minEfVecY(),
    },
  };
}

function solveMinEfCandidates(
  exports: RustCoreExports,
  start: State,
  stock: Stock,
  horizonFactor: number,
  normPower: number,
  tolerance: number,
) {
  runMinEf(exports, start, stock, horizonFactor, normPower, tolerance);
  assertRustStatusOk(exports, "min-ef root candidates");
  return readMinEfRootCandidates(exports, tolerance);
}

function lookupMinEfAction(exports: RustCoreExports, state: State, stockUses: Stock) {
  const stateId = encodeState(state.grade, state.level, state.exp ?? 0);
  const action = exports.minEfActionAtOrSolve(
    stateId,
    stockUses.blue | 0,
    stockUses.purple | 0,
    stockUses.yellow | 0,
  );
  assertRustStatusOk(exports, "action lookup");
  return actionFromIndex(action);
}
