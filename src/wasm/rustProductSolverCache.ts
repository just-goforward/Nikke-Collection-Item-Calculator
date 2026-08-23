import {
  isConvertStateNormalized as isConvertState,
  isTerminalNormalized as isTerminal,
} from "../solver/domain";
import type { CollectionState, Kit, Stock } from "../types";
import { activeSupplyForecastContext } from "./rustCoreShared";
import { loadRustMinEfSolver, loadRustPhase2Solver } from "./rustLoader";
import type { RustProductInput } from "./rustProductInput";
import type { RustActionLookup } from "./rustProductView";
import type {
  RustMinEfPolicyHandle,
  RustMinEfSolver,
  RustPhase2ProductSolver,
  SupplyForecastContext,
} from "./rustTypes";

let minEfSolverPromise: Promise<RustMinEfSolver> | null = null;
let phase2SolverPromise: Promise<RustPhase2ProductSolver> | null = null;

type MinEfPolicyCacheEntry = {
  key: string;
  policy: RustMinEfPolicyHandle;
};

let lastMinEfPolicy: MinEfPolicyCacheEntry | null = null;

export async function getRustMinEfSolver(wasmUrl: string) {
  minEfSolverPromise ??= loadRustMinEfSolver(wasmUrl);
  return minEfSolverPromise;
}

export async function getRustPhase2Solver(wasmUrl: string) {
  phase2SolverPromise ??= loadRustPhase2Solver(wasmUrl);
  return phase2SolverPromise;
}

export async function releaseRustMinEfSolverCache() {
  const solverPromise = minEfSolverPromise;
  minEfSolverPromise = null;
  clearLastMinEfPolicy();
  if (!solverPromise) return;
  const solver = await solverPromise;
  solver.releaseMemo();
}

export function minEfActionFactory(policy: RustMinEfPolicyHandle): RustActionLookup {
  return (state: CollectionState, stockUses: Stock): Kit | null => {
    if (isTerminal(state) || isConvertState(state)) return null;
    return policy.actionAt(state, stockUses);
  };
}

export function minEfPolicyCacheKey({
  horizonFactor,
  input,
  memoTier,
  normPower,
  supplyForecast = activeSupplyForecastContext(),
  tolerance,
}: {
  horizonFactor: number;
  input: RustProductInput;
  memoTier: number;
  normPower: number;
  supplyForecast?: SupplyForecastContext;
  tolerance: number;
}) {
  return [
    supplyForecast.forecastId,
    supplyForecast.forecastProfileId,
    supplyForecast.expectedGain.blue,
    supplyForecast.expectedGain.purple,
    supplyForecast.expectedGain.yellow,
    input.start.grade,
    input.start.level,
    input.start.exp ?? 0,
    input.stock.blue,
    input.stock.purple,
    input.stock.yellow,
    horizonFactor,
    normPower,
    tolerance,
    memoTier,
  ].join("|");
}

export function rememberLastMinEfPolicy(key: string, policy: RustMinEfPolicyHandle) {
  lastMinEfPolicy = { key, policy };
}

export function readLastMinEfPolicy(key: string) {
  return lastMinEfPolicy?.key === key ? lastMinEfPolicy.policy : null;
}

export function clearLastMinEfPolicy() {
  lastMinEfPolicy = null;
}
