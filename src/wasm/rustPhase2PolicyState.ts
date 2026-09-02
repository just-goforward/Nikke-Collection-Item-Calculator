import { clampMemoStockUses } from "../solver/domain";
import type { Kit } from "../types";
import {
  actionFromIndex,
  encodeState,
  type Phase2BuildContext,
  phase2ContextMatches,
  requireExport,
} from "./rustCoreShared";
import { assertRustStatusOk, RustSolveError } from "./rustStatus";
import type { RustCoreExports, State, Stock, SupplyForecastContext } from "./rustTypes";

export type Phase2FactoryState = {
  buildGeneration: number;
  currentBuild: Phase2BuildContext | null;
  exports: RustCoreExports;
  memoTier: number;
  segmentedOverflow: boolean;
  supplyForecast: SupplyForecastContext;
};

export function recordPhase2Build(state: Phase2FactoryState, context: Phase2BuildContext) {
  state.currentBuild = context;
  state.buildGeneration += 1;
  return state.buildGeneration;
}

export function assertCurrentPhase2Build(
  state: Phase2FactoryState,
  expected: Phase2BuildContext,
  operation: string,
  options: { compareTolerance?: boolean } = {},
) {
  if (phase2ContextMatches(state.currentBuild, expected, options)) return;
  throw new Error(`Rust phase2 ${operation} does not match the current policy build.`);
}

function assertPhase2PolicyGeneration(state: Phase2FactoryState, generation: number) {
  if (generation === state.buildGeneration) return;
  throw new RustSolveError("phase2 policy", null, "stale_handle");
}

export function actionAtForPhase2Generation(
  state: Phase2FactoryState,
  generation: number,
  nodeState: State,
  stockUses: Stock,
): Kit | null {
  assertPhase2PolicyGeneration(state, generation);
  const policyActionAt = requireExport(state.exports, "policyActionAt");
  const stateId = encodeState(nodeState.grade, nodeState.level, nodeState.exp ?? 0);
  const boundedStock = clampMemoStockUses(stockUses);
  const action = policyActionAt(
    stateId,
    boundedStock.blue | 0,
    boundedStock.purple | 0,
    boundedStock.yellow | 0,
  );
  assertRustStatusOk(state.exports, "phase2 action lookup");
  return actionFromIndex(action);
}
