import type { Kit, Stock } from "../../src/types";
import type { NodeResult } from "./exact-replan-types";

export function zeroConsumption(): Stock {
  return { blue: 0, purple: 0, yellow: 0 };
}

export function emptyAggregate(): NodeResult {
  return {
    successProbability: 0,
    expectedConsumption: zeroConsumption(),
    exhaustionProbability: zeroConsumption(),
    minimumRemainingPieces: {
      blue: Number.POSITIVE_INFINITY,
      purple: Number.POSITIVE_INFINITY,
      yellow: Number.POSITIVE_INFINITY,
    },
    manualEntryProbability: 0,
    expectedManualEntries: 0,
    successAttemptSelectionProbability: 0,
    expectedSuccessAttemptSelections: 0,
  };
}

export function terminalNode(successProbability: number, stock: Stock): NodeResult {
  return {
    ...emptyAggregate(),
    successProbability,
    exhaustionProbability: {
      blue: stock.blue < 10 ? 1 : 0,
      purple: stock.purple < 10 ? 1 : 0,
      yellow: stock.yellow < 10 ? 1 : 0,
    },
    minimumRemainingPieces: { ...stock },
  };
}

export function stateStockKey(state: { grade: string; level: number; exp?: number }, stock: Stock) {
  return `${state.grade}:${state.level}:${state.exp}|${stock.blue}:${stock.purple}:${stock.yellow}`;
}

export function consume(stock: Stock, kit: Kit, attempts: number): Stock {
  return {
    ...stock,
    [kit]: Math.max(0, stock[kit] - attempts * 10),
  };
}
