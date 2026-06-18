import {
  phase2BuildContext,
  readPhase2Root,
  readRootCandidates,
  solvePhase2Slot,
} from "./rustCoreShared";
import {
  actionAtForPhase2Generation,
  type Phase2FactoryState,
  recordPhase2Build,
} from "./rustPhase2PolicyState";
import { simulatePolicy, simulatePolicyAfterFirstAction } from "./rustPhase2Validation";
import type {
  RustCoreExports,
  RustPhase2Policy,
  RustPhase2ProductSolver,
  State,
  Stock,
} from "./rustTypes";

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

export function createRustPhase2Solver(exports: RustCoreExports): RustPhase2ProductSolver {
  exports.configureMemo?.(21);
  exports.configureNodeBudget?.(0);
  const state: Phase2FactoryState = { buildGeneration: 0, currentBuild: null, exports };
  return {
    buildPolicy: (...args) => buildPolicy(state, ...args),
    solveRoot: (...args) => buildPolicy(state, ...args).root,
    rootCandidates: (...args) => rootCandidates(state, ...args),
    simulatePolicy: (...args) => simulatePolicy(state, ...args),
    simulatePolicyAfterFirstAction: (...args) => simulatePolicyAfterFirstAction(state, ...args),
  };
}
