import { describe, expect, it } from "vitest";

import { evaluateExactInteractiveReplan } from "./evaluator/exact-replan";
import { FIXED_SAFETY_GRID } from "./scenarios/fixed-grid";

describe("exact interactive-replan research contract", () => {
  it("preserves raw remainder stock through R15 conversion and terminal risk metrics", () => {
    const calls: Array<{ start: { grade: string; level: number }; stock: Record<string, number> }> =
      [];
    const scenario = {
      id: "R15-remainder-contract",
      group: "scarcity" as const,
      start: { grade: "R" as const, level: 15, exp: 0 },
      stock: { blue: 9, purple: 10, yellow: 19 },
    };
    const result = evaluateExactInteractiveReplan(scenario, {
      policySolver(input) {
        calls.push({ start: input.start, stock: input.stock });
        return { possible: false, best: null };
      },
      timeBudgetMs: 1_000,
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected completed conversion fixture.");
    expect(calls).toEqual([
      {
        start: { grade: "SR", level: 5, exp: 0 },
        stock: { blue: 9, purple: 10, yellow: 19 },
      },
    ]);
    expect(result.exhaustionProbability).toEqual({ blue: 1, purple: 0, yellow: 0 });
    expect(result.minimumRemainingPieces).toEqual(scenario.stock);
  });

  it("matches direct enumeration for a two-use recommendation", () => {
    const scenario = {
      id: "two-use-direct-enumeration",
      group: "scarcity" as const,
      start: { grade: "SR" as const, level: 14, exp: 0 },
      stock: { blue: 20, purple: 19, yellow: 9 },
    };
    const result = evaluateExactInteractiveReplan(scenario, {
      policySolver(input) {
        if (input.stock.blue < 10) return { possible: false, best: null };
        return {
          possible: true,
          best: {
            firstAction: "blue",
            run: { count: 2 },
            probabilityGap: 0,
          },
        };
      },
      timeBudgetMs: 1_000,
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected direct enumeration fixture.");
    // Two 10%-success attempts: P(success) = 0.1 + 0.9*0.1 = 0.19.
    expect(result.successProbability).toBeCloseTo(0.19, 12);
    // 10 pieces on first success, otherwise 20: 0.1*10 + 0.9*20 = 19.
    expect(result.expectedConsumption.blue).toBeCloseTo(19, 12);
    expect(result.expectedConsumption.purple).toBe(0);
    expect(result.expectedConsumption.yellow).toBe(0);
    expect(result.exhaustionProbability.blue).toBeCloseTo(0.9, 12);
    expect(result.exhaustionProbability.purple).toBe(0);
    expect(result.exhaustionProbability.yellow).toBe(1);
    expect(result.minimumRemainingPieces).toEqual({ blue: 0, purple: 19, yellow: 9 });
  });

  it("returns a typed solver failure without classifying it as verification evidence", () => {
    const scenario = FIXED_SAFETY_GRID[0];
    if (!scenario) throw new Error("Expected at least one fixed safety scenario.");
    const result = evaluateExactInteractiveReplan(scenario, {
      policySolver() {
        throw new Error("synthetic policy failure");
      },
      timeBudgetMs: 1_000,
    });

    expect(result).toMatchObject({
      status: "solver_failure",
      reason: "policy_solver_error",
      errorMessage: "synthetic policy failure",
      solveCalls: 1,
    });
  });
});
