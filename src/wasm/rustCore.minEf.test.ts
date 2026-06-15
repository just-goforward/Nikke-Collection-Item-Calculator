import { describe, expect, it, vi } from "vitest";

import { createRustMinEfSolver, isMemoFull } from "./rustCore";
import { makeRustCoreExports as makeExports } from "./rustCore.test-helper";

describe("rust min-E[f] core wrapper", () => {
  it("configures memo and deterministic node budget on creation", () => {
    const exports = makeExports();

    createRustMinEfSolver(exports);

    expect(exports.configureMemo).toHaveBeenCalledWith(21);
    expect(exports.configureNodeBudget).toHaveBeenCalledWith(2_000_000);
  });

  it("throws on root-solve budget status before reading result accessors", () => {
    const exports = makeExports({
      getSolveStatus: vi.fn(() => 1),
      minEfAction: vi.fn(() => {
        throw new Error("accessor should not be read");
      }),
    });
    const solver = createRustMinEfSolver(exports);

    expect(() =>
      solver.solveRoot({ grade: "R", level: 0, exp: 0 }, { blue: 10, purple: 10, yellow: 10 }),
    ).toThrow("budget_exceeded");
    expect(exports.minEfAction).not.toHaveBeenCalled();
  });

  it("throws on action lookup memo-full status after the endpoint call", () => {
    const exports = makeExports({
      getSolveStatus: vi.fn(() => 2),
      minEfActionAtOrSolve: vi.fn(() => 1),
    });
    const solver = createRustMinEfSolver(exports);

    expect(() =>
      solver.actionAt({ grade: "SR", level: 1, exp: 0 }, { blue: 1, purple: 1, yellow: 1 }),
    ).toThrow("memo_full");
    expect(exports.minEfActionAtOrSolve).toHaveBeenCalledOnce();
  });

  it("returns a normal result when status is OK", () => {
    const solver = createRustMinEfSolver(makeExports());

    expect(
      solver.solveRoot({ grade: "SR", level: 1, exp: 0 }, { blue: 10, purple: 10, yellow: 10 }),
    ).toEqual({
      firstAction: "blue",
      successProbability: 0.9,
      maxSuccessProbability: 0.95,
      vector: { blue: 10, purple: 20, yellow: 30 },
      expectedCost: 0.123,
    });
    expect(
      solver.actionAt({ grade: "SR", level: 1, exp: 0 }, { blue: 1, purple: 1, yellow: 1 }),
    ).toBe("purple");
  });

  it("reads min-E[f] root candidates from the last root solve scratch", () => {
    const solver = createRustMinEfSolver(makeExports());

    expect(
      solver.rootCandidates(
        { grade: "SR", level: 1, exp: 0 },
        { blue: 10, purple: 10, yellow: 10 },
      ),
    ).toEqual([
      {
        firstAction: "blue",
        successProbability: 0.95,
        maxSuccessProbability: 0.95,
        probabilityGap: 0,
        vector: { blue: 10, purple: 20, yellow: 30 },
        resourceCost: 0.1,
        eligible: true,
      },
      {
        firstAction: "yellow",
        successProbability: 0.94,
        maxSuccessProbability: 0.95,
        probabilityGap: 0.010000000000000009,
        vector: { blue: 12, purple: 22, yellow: 32 },
        resourceCost: 2.1,
        eligible: false,
      },
    ]);
  });

  it("exposes memo-full as a typed Rust solve error", () => {
    const solver = createRustMinEfSolver(
      makeExports({
        getSolveStatus: vi.fn(() => 2),
      }),
    );

    let thrown: unknown;
    try {
      solver.rootCandidates(
        { grade: "SR", level: 1, exp: 0 },
        { blue: 10, purple: 10, yellow: 10 },
      );
    } catch (error) {
      thrown = error;
    }
    expect(isMemoFull(thrown)).toBe(true);
  });
});
