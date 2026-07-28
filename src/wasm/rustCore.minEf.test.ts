import { describe, expect, it, vi } from "vitest";
import { makeRustCoreExports as makeExports } from "./rustCore.test-helper";
import { createRustMinEfSolver } from "./rustMinEfCore";
import { isMemoFull } from "./rustStatus";

describe("rust min-E[f] core wrapper", () => {
  it("configures memo and deterministic node budget on creation", () => {
    const exports = makeExports();

    createRustMinEfSolver(exports);

    expect(exports.configureMemo).toHaveBeenCalledWith(21);
    expect(exports.configureMinEfMemo).toHaveBeenCalledWith(21);
    expect(exports.configureNodeBudget).toHaveBeenCalledWith(2_000_000);
  });

  it("can reconfigure and release the min-E[f] memo", () => {
    const exports = makeExports();
    const solver = createRustMinEfSolver(exports);

    solver.configureMemoTier(20);
    solver.releaseMemo();

    expect(solver.memoTier()).toBe(20);
    expect(exports.configureMinEfMemo).toHaveBeenLastCalledWith(20);
    expect(exports.releaseMinEfMemo).toHaveBeenCalledOnce();
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
      solver.solveRootWithCandidates(
        { grade: "R", level: 0, exp: 0 },
        { blue: 10, purple: 10, yellow: 10 },
      ),
    ).toThrow("budget_exceeded");
    expect(exports.minEfAction).not.toHaveBeenCalled();
  });

  it("throws on action lookup memo-full status after the endpoint call", () => {
    const exports = makeExports({
      getSolveStatus: vi.fn().mockReturnValueOnce(0).mockReturnValue(2),
      minEfActionAtOrSolve: vi.fn(() => 1),
    });
    const solver = createRustMinEfSolver(exports);
    const policy = solver.solveRootWithCandidates(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 10, purple: 10, yellow: 10 },
    );

    expect(() =>
      policy.actionAt({ grade: "SR", level: 1, exp: 0 }, { blue: 1, purple: 1, yellow: 1 }),
    ).toThrow("memo_full");
    expect(exports.minEfActionAtOrSolve).toHaveBeenCalledOnce();
  });

  it("returns a normal result when status is OK", () => {
    const solver = createRustMinEfSolver(makeExports());

    expect(
      solver.solveRootWithCandidates(
        { grade: "SR", level: 1, exp: 0 },
        { blue: 10, purple: 10, yellow: 10 },
      ).root,
    ).toEqual({
      firstAction: "blue",
      successProbability: 0.9,
      maxSuccessProbability: 0.95,
      vector: { blue: 10, purple: 20, yellow: 30 },
      expectedCost: 0.123,
      states: 4321,
    });
    expect(
      solver
        .solveRootWithCandidates(
          { grade: "SR", level: 1, exp: 0 },
          { blue: 10, purple: 10, yellow: 10 },
        )
        .actionAt({ grade: "SR", level: 1, exp: 0 }, { blue: 1, purple: 1, yellow: 1 }),
    ).toBe("purple");
  });

  it("reads min-E[f] root candidates from the last root solve scratch", () => {
    const exports = makeExports();
    const solver = createRustMinEfSolver(exports);

    expect(
      solver.solveRootWithCandidates(
        { grade: "SR", level: 1, exp: 0 },
        { blue: 10, purple: 10, yellow: 10 },
      ).candidates,
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
    expect(exports.solveMinEf).toHaveBeenCalledOnce();
  });

  it("invalidates min-E[f] policy handles after a newer root solve", () => {
    const exports = makeExports();
    const solver = createRustMinEfSolver(exports);
    const policy = solver.solveRootWithCandidates(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 10, purple: 10, yellow: 10 },
    );

    solver.solveRootWithCandidates(
      { grade: "SR", level: 2, exp: 0 },
      { blue: 30, purple: 30, yellow: 30 },
    );

    expect(() =>
      policy.actionAt({ grade: "SR", level: 1, exp: 0 }, { blue: 1, purple: 1, yellow: 1 }),
    ).toThrow("stale");
    expect(exports.minEfActionAtOrSolve).not.toHaveBeenCalled();
  });

  it("invalidates min-E[f] policy handles after memo release", () => {
    const exports = makeExports();
    const solver = createRustMinEfSolver(exports);
    const policy = solver.solveRootWithCandidates(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 10, purple: 10, yellow: 10 },
    );

    solver.releaseMemo();

    expect(() =>
      policy.actionAt({ grade: "SR", level: 1, exp: 0 }, { blue: 1, purple: 1, yellow: 1 }),
    ).toThrow("stale");
    expect(exports.minEfActionAtOrSolve).not.toHaveBeenCalled();
  });

  it("exposes memo-full as a typed Rust solve error", () => {
    const solver = createRustMinEfSolver(
      makeExports({
        getSolveStatus: vi.fn(() => 2),
      }),
    );

    let thrown: unknown;
    try {
      solver.solveRootWithCandidates(
        { grade: "SR", level: 1, exp: 0 },
        { blue: 10, purple: 10, yellow: 10 },
      );
    } catch (error) {
      thrown = error;
    }
    expect(isMemoFull(thrown)).toBe(true);
    if (isMemoFull(thrown)) expect(thrown.nodeCount).toBe(4321);
  });
});

describe("rust min-E[f] memo-key boundary", () => {
  it("passes raw pieces to min-E[f] solve and caps only memo-key lookups", () => {
    const exports = makeExports();
    const solver = createRustMinEfSolver(exports);
    const policy = solver.solveRootWithCandidates(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 61, purple: 121, yellow: 901 },
    );

    policy.actionAt(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 999_999, purple: 999_999, yellow: 999_999 },
    );

    expect(exports.solveMinEf).toHaveBeenCalledWith(510, 61, 121, 901, 0.75, 3, 0);
    expect(exports.minEfActionAtOrSolve).toHaveBeenCalledWith(510, 220, 88, 44);
  });
});
