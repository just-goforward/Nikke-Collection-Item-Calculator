import { describe, expect, it } from "vitest";

import { convertState, normalizeState, solve, transition } from "./solver";

describe("solver transitions", () => {
  it("normalizes max level states without carrying extra exp", () => {
    expect(normalizeState({ grade: "R", level: 15, exp: 900 })).toEqual({ grade: "R", level: 15, exp: 0 });
    expect(normalizeState({ grade: "SR", level: 99, exp: 2900 })).toEqual({ grade: "SR", level: 15, exp: 0 });
  });

  it("converts R15 into SR5", () => {
    expect(convertState()).toEqual({ grade: "SR", level: 5, exp: 0 });
    const result = solve(
      {
        start: { grade: "R", level: 15, exp: 0 },
        stock: { blue: 0, purple: 0, yellow: 0 },
      },
      undefined,
    );
    expect(result.convertOnly).toBe(true);
    expect(result.best.firstAction).toBe("convert");
    expect(result.best.successProbability).toBe(1);
  });

  it("applies SR 10 purple transition probability and fail exp", () => {
    const result = transition({ grade: "SR", level: 10, exp: 0 }, "purple");
    expect(result.probability).toBeCloseTo(0.054, 6);
    expect(result.success).toEqual({ grade: "SR", level: 15, exp: 0 });
    expect(result.fail).toEqual({ grade: "SR", level: 10, exp: 500 });
  });
});

describe("solver policy", () => {
  it("returns a possible exact MDP result for a representative inventory", () => {
    const result = solve(
      {
        start: { grade: "SR", level: 10, exp: 0 },
        stock: { blue: 0, purple: 0, yellow: 100 },
        strategy: "single",
      },
      undefined,
    );
    expect(result.possible).toBe(true);
    expect(result.best.firstAction).toMatch(/blue|purple|yellow/);
    expect(result.stats.exact).toBe(true);
    expect(result.topCandidates.length).toBeGreaterThan(0);
  });

  it("keeps Monte Carlo validation deterministic for the same seed", () => {
    const input = {
      start: { grade: "SR" as const, level: 10, exp: 0 },
      stock: { blue: 80, purple: 60, yellow: 20 },
      strategy: "supply" as const,
      monteCarloRuns: 500,
      monteCarloSeed: 12345,
    };
    const first = solve(input, undefined).monteCarlo;
    const second = solve(input, undefined).monteCarlo;
    expect(second).toEqual(first);
    expect(first.runs).toBe(500);
  });
});
