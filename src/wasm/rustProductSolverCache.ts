import {
  isConvertStateNormalized as isConvertState,
  isTerminalNormalized as isTerminal,
} from "../solver/domain";
import type { CollectionState, Kit, Stock } from "../types";
import { loadRustMinEfSolver, loadRustPhase2Solver } from "./rustCore";
import type { RustActionLookup } from "./rustProductView";
import type { RustMinEfPolicyHandle, RustMinEfSolver, RustPhase2Solver } from "./rustTypes";

let minEfSolverPromise: Promise<RustMinEfSolver> | null = null;
let phase2SolverPromise: Promise<RustPhase2Solver> | null = null;

export async function getRustMinEfSolver(wasmUrl: string) {
  minEfSolverPromise ??= loadRustMinEfSolver(wasmUrl);
  return minEfSolverPromise;
}

export async function getRustPhase2Solver(wasmUrl: string) {
  phase2SolverPromise ??= loadRustPhase2Solver(wasmUrl);
  return phase2SolverPromise;
}

export function minEfActionFactory(policy: RustMinEfPolicyHandle): RustActionLookup {
  return (state: CollectionState, stockUses: Stock): Kit | null => {
    if (isTerminal(state) || isConvertState(state)) return null;
    return policy.actionAt(state, stockUses);
  };
}
