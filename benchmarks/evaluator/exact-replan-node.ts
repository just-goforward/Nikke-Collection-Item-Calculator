import type { Kit, Stock } from "../../src/types";
import type { NodeResult } from "./exact-replan-types";

export function zeroConsumption(): Stock {
  return { blue: 0, purple: 0, yellow: 0 };
}

export function terminalNode(successProbability: number): NodeResult {
  return {
    successProbability,
    expectedConsumption: zeroConsumption(),
    manualEntryProbability: 0,
    expectedManualEntries: 0,
    successAttemptSelectionProbability: 0,
    expectedSuccessAttemptSelections: 0,
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
