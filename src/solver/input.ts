import type { CollectionState, Grade, KitVector, Strategy } from "./domain";
import {
  clamp,
  FIXED_REQUIRED_EXP,
  MAX_RELEVANT_USES,
  normalizeState,
  normalizeStock,
  stockToUses,
} from "./domain";
import { normalizeStrategy } from "./gate";

export type RawSolverInput = {
  start?: Partial<CollectionState> | null;
  stock?: Partial<KitVector> | null;
  strategy?: unknown;
  monteCarloRuns?: unknown;
  monteCarloSeed?: unknown;
};

export type NormalizedSolverInput = {
  start: CollectionState;
  strategy: Strategy;
  stock: KitVector;
  actualStockUses: KitVector;
  stockUses: KitVector;
  requiredExp: Record<Grade, number>;
};

export function normalizeSolverInput(input: RawSolverInput): NormalizedSolverInput {
  const grade = input.start && input.start.grade === "SR" ? "SR" : "R";
  const required = FIXED_REQUIRED_EXP[grade];
  const exp = clamp(Math.floor((Number(input.start?.exp) || 0) / 100) * 100, 0, required - 100);
  const stock = normalizeStock(input.stock || {});
  const actualStockUses = stockToUses(stock);

  return {
    start: normalizeState({
      grade,
      level: input.start?.level ?? 0,
      exp,
    }),
    strategy: normalizeStrategy(input.strategy),
    stock,
    actualStockUses,
    stockUses: {
      blue: Math.min(actualStockUses.blue, MAX_RELEVANT_USES.blue),
      purple: Math.min(actualStockUses.purple, MAX_RELEVANT_USES.purple),
      yellow: Math.min(actualStockUses.yellow, MAX_RELEVANT_USES.yellow),
    },
    requiredExp: FIXED_REQUIRED_EXP,
  };
}

export function readMonteCarloRuns(input: RawSolverInput) {
  return Math.max(0, Math.floor(Number(input.monteCarloRuns) || 0));
}

export function readMonteCarloSeed(input: RawSolverInput) {
  return Math.max(0, Math.floor(Number(input.monteCarloSeed) || 20260505));
}
