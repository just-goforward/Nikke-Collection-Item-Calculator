import {
  clampMemoStockUses,
  KIT_ORDER,
  type Kit,
  stateIdNormalized,
  stockToUses,
} from "../src/solver/domain";
import type { SolverInput } from "../src/types";
import type { RustCoreExports } from "../src/wasm/rustTypes";

export type RustPrioritizedSparsePiOutcome =
  | "completed"
  | "phase2_failure"
  | "iteration_budget_exceeded"
  | "state_budget_exceeded"
  | "invalid_input";

export type RustPrioritizedSparsePiOptions = {
  horizonFactor?: number;
  maxPasses?: number;
  maxStates?: number;
  maxUpdatesPerPass?: number;
  memoTier?: number;
  normPower?: number;
  tolerance?: number;
};

export type RustPrioritizedSparsePiResult = {
  outcome: RustPrioritizedSparsePiOutcome;
  elapsedMs: number;
  finalAction: Kit | null;
  success: number;
  cost: number;
  vector: { blue: number; purple: number; yellow: number };
  probabilityGap: number;
  passes: number;
  peakStates: number;
  scannedStates: number;
  changes: number;
  overrides: number;
};

const OUTCOMES: readonly RustPrioritizedSparsePiOutcome[] = [
  "completed",
  "phase2_failure",
  "iteration_budget_exceeded",
  "state_budget_exceeded",
  "invalid_input",
] as const;

function requireFunction<T extends keyof RustCoreExports>(
  exports: RustCoreExports,
  name: T,
): NonNullable<RustCoreExports[T]> {
  const value = exports[name];
  if (typeof value !== "function")
    throw new Error(`Missing candidate WASM export: ${String(name)}`);
  return value as NonNullable<RustCoreExports[T]>;
}

export function solveRustPrioritizedSparsePi(
  exports: RustCoreExports,
  input: SolverInput,
  options: RustPrioritizedSparsePiOptions = {},
): RustPrioritizedSparsePiResult {
  const startedAt = performance.now();
  exports.configureMemo?.(options.memoTier ?? 22);
  exports.configureNodeBudget?.(0);
  requireFunction(exports, "solvePrioritizedSparsePi")(
    stateIdNormalized(input.start),
    input.stock.blue | 0,
    input.stock.purple | 0,
    input.stock.yellow | 0,
    options.horizonFactor ?? 0.75,
    options.normPower ?? 3,
    options.tolerance ?? 0,
    options.maxPasses ?? 40,
    options.maxStates ?? 1_200_000,
    options.maxUpdatesPerPass ?? 256,
  );
  const outcomeCode = requireFunction(exports, "prioritizedSparsePiOutcome")();
  const actionIndex = requireFunction(exports, "prioritizedSparsePiAction")();
  return {
    outcome: OUTCOMES[outcomeCode] ?? "invalid_input",
    elapsedMs: performance.now() - startedAt,
    finalAction: actionIndex >= 0 ? (KIT_ORDER[actionIndex] ?? null) : null,
    success: requireFunction(exports, "prioritizedSparsePiSuccess")(),
    cost: requireFunction(exports, "prioritizedSparsePiCost")(),
    vector: {
      blue: requireFunction(exports, "prioritizedSparsePiVecB")(),
      purple: requireFunction(exports, "prioritizedSparsePiVecP")(),
      yellow: requireFunction(exports, "prioritizedSparsePiVecY")(),
    },
    probabilityGap: requireFunction(exports, "prioritizedSparsePiProbabilityGap")(),
    passes: requireFunction(exports, "prioritizedSparsePiPasses")(),
    peakStates: requireFunction(exports, "prioritizedSparsePiPeakStates")(),
    scannedStates: requireFunction(exports, "prioritizedSparsePiScannedStates")(),
    changes: requireFunction(exports, "prioritizedSparsePiChanges")(),
    overrides: requireFunction(exports, "prioritizedSparsePiOverrideCount")(),
  };
}

export function prioritizedSparsePiActionAt(
  exports: RustCoreExports,
  stateId: number,
  stock: { blue: number; purple: number; yellow: number },
) {
  const uses = clampMemoStockUses(stockToUses(stock));
  return requireFunction(exports, "prioritizedSparsePiActionAt")(
    stateId,
    uses.blue,
    uses.purple,
    uses.yellow,
  );
}
