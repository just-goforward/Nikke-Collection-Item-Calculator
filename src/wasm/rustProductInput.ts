import {
  clamp,
  FIXED_REQUIRED_EXP,
  MAX_RELEVANT_USES,
  normalizeState,
  normalizeStock,
  stockToUses,
} from "../solver/domain";
import type { SolverInput, Stock } from "../types";

export type RustProductInput = SolverInput & {
  actualStockUses: Stock;
  stockUses: Stock;
  requiredExp: typeof FIXED_REQUIRED_EXP;
};

export function normalizeRustProductInput(input: SolverInput): RustProductInput {
  const grade = input.start?.grade === "SR" ? "SR" : "R";
  const required = FIXED_REQUIRED_EXP[grade];
  const exp = clamp(Math.floor((Number(input.start?.exp) || 0) / 100) * 100, 0, required - 100);
  const stock = normalizeStock(input.stock || {});
  const actualStockUses = stockToUses(stock);

  return {
    start: normalizeState({
      grade,
      level: input.start ? input.start.level : 0,
      exp,
    }),
    strategy: "supply",
    stock,
    actualStockUses,
    stockUses: {
      blue: Math.min(actualStockUses.blue, MAX_RELEVANT_USES.blue),
      purple: Math.min(actualStockUses.purple, MAX_RELEVANT_USES.purple),
      yellow: Math.min(actualStockUses.yellow, MAX_RELEVANT_USES.yellow),
    },
    requiredExp: FIXED_REQUIRED_EXP,
    ...(input.monteCarloRuns !== undefined ? { monteCarloRuns: input.monteCarloRuns } : {}),
    ...(input.monteCarloSeed !== undefined ? { monteCarloSeed: input.monteCarloSeed } : {}),
  };
}

export function readRustMonteCarloRuns(input: SolverInput) {
  return Math.max(0, Math.floor(Number(input.monteCarloRuns) || 0));
}

export function readRustMonteCarloSeed(input: SolverInput) {
  return Math.max(0, Math.floor(Number(input.monteCarloSeed) || 20260505));
}
