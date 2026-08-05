import { describe, expect, it, vi } from "vitest";

import { makeRustCoreExports as makeExports } from "./rustCore.test-helper";
import {
  createRustPhase2ResearchSolver as createRustPhase2Solver,
  selectExactRerankCandidate,
} from "./rustPhase2ResearchCore";
import type { RustExactRerankedCandidate } from "./rustTypes";

describe("rust phase2 policy wrapper", () => {
  it("keeps the phase2 baseline when exact rerank costs tie", () => {
    const candidate = (
      firstAction: RustExactRerankedCandidate["firstAction"],
      expectedCost: number,
    ): RustExactRerankedCandidate => ({
      firstAction,
      expectedCost,
      nodeCount: 1,
      successProbability: 0.99,
      maxSuccessProbability: 0.99,
      probabilityGap: 0,
      vector: { blue: 1, purple: 1, yellow: 1 },
      resourceCost: expectedCost,
      eligible: true,
    });
    const candidates = [
      candidate("blue", 0.2),
      candidate("purple", 0.2 - 5e-13),
      candidate("yellow", 0.19),
    ];

    expect(selectExactRerankCandidate(candidates.slice(0, 2), "blue").firstAction).toBe("blue");
    expect(selectExactRerankCandidate(candidates, "blue").firstAction).toBe("yellow");
  });

  it("looks up phase2 actions from the current policy memo without re-solving", () => {
    const exports = makeExports();
    const solver = createRustPhase2Solver(exports);

    const policy = solver.buildPolicy(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 10, purple: 20, yellow: 30 },
    );

    expect(
      policy.actionAt({ grade: "SR", level: 1, exp: 0 }, { blue: 1, purple: 2, yellow: 3 }),
    ).toBe("purple");
    expect(exports.policyActionAt).toHaveBeenCalledWith(510, 1, 2, 3);
    expect(exports.solveCore).toHaveBeenCalledTimes(1);
  });

  it("passes raw pieces to phase2 solve and caps only memo-key lookups", () => {
    const exports = makeExports();
    const solver = createRustPhase2Solver(exports);
    const policy = solver.buildPolicy(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 2_211, purple: 891, yellow: 451 },
    );

    policy.actionAt(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 999_999, purple: 999_999, yellow: 999_999 },
    );

    expect(exports.solveCore).toHaveBeenCalledWith(510, 2_211, 891, 451, 0.75, 3, 0);
    expect(exports.policyActionAt).toHaveBeenCalledWith(510, 220, 88, 44);
  });

  it("invalidates phase2 policy handles after a newer policy build", () => {
    const exports = makeExports();
    const solver = createRustPhase2Solver(exports);
    const policy = solver.buildPolicy(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 10, purple: 20, yellow: 30 },
    );

    solver.solveRoot({ grade: "SR", level: 2, exp: 0 }, { blue: 40, purple: 50, yellow: 60 });

    expect(() =>
      policy.actionAt({ grade: "SR", level: 1, exp: 0 }, { blue: 1, purple: 2, yellow: 3 }),
    ).toThrow("stale");
    expect(exports.policyActionAt).not.toHaveBeenCalled();
  });

  it("uses Rust policy Monte Carlo exports for phase2 validation", () => {
    const exports = makeExports();
    const solver = createRustPhase2Solver(exports);

    solver.solveRoot({ grade: "SR", level: 1, exp: 0 }, { blue: 10, purple: 20, yellow: 30 });

    expect(
      solver.simulatePolicy(
        { grade: "SR", level: 1, exp: 0 },
        { blue: 10, purple: 20, yellow: 30 },
        100,
        20260505,
      ),
    ).toEqual({
      runs: 100,
      completed: 80,
      successProbability: 0.8,
      vector: { blue: 1, purple: 2, yellow: 3 },
    });
    expect(exports.simulateCore).toHaveBeenCalledWith(510, 10, 20, 30, 100, 20260505);
  });

  it("throws before phase2 policy Monte Carlo when the requested context differs from the current build", () => {
    const exports = makeExports();
    const solver = createRustPhase2Solver(exports);

    solver.solveRoot({ grade: "SR", level: 1, exp: 0 }, { blue: 10, purple: 20, yellow: 30 });

    expect(() =>
      solver.simulatePolicy(
        { grade: "SR", level: 2, exp: 0 },
        { blue: 10, purple: 20, yellow: 30 },
        100,
        20260505,
      ),
    ).toThrow("does not match");
    expect(exports.simulateCore).not.toHaveBeenCalled();
  });

  it("throws on first-action E[f] simulation status before reading MC accessors", () => {
    const exports = makeExports({
      getSolveStatus: vi.fn(() => 1),
      getMcEf: vi.fn(() => {
        throw new Error("MC accessor should not be read");
      }),
    });
    const solver = createRustPhase2Solver(exports);

    expect(() =>
      solver.estimateExpectedCostAfterFirstAction(
        { grade: "SR", level: 1, exp: 0 },
        { blue: 10, purple: 10, yellow: 10 },
        "blue",
        100,
        20260509,
      ),
    ).toThrow("budget_exceeded");
    expect(exports.getMcEf).not.toHaveBeenCalled();
  });

  it("reranks only exact-eligible phase2 candidates by first-action E[f]", () => {
    let lastAction = -1;
    const exports = makeExports({
      rootCandidateValid: vi.fn(() => 1),
      rootCandidateMaxSuccessProb: vi.fn(() => 0.9),
      rootCandidateSuccessProb: vi.fn((action: number) => {
        if (action === 0) return 0.9;
        if (action === 1) return 0.895;
        return 0.85;
      }),
      simulateExpectedFAfterFirstAction: vi.fn((...args: number[]) => {
        lastAction = args[12] ?? -1;
      }),
      simulateExpectedFAfterFirstActionFromPolicy: vi.fn((...args: number[]) => {
        lastAction = args[11] ?? -1;
      }),
      getMcEf: vi.fn(() => {
        if (lastAction === 0) return 0.4;
        if (lastAction === 1) return 0.2;
        return 0.1;
      }),
    });
    const solver = createRustPhase2Solver(exports);

    const result = solver.selectFirstActionByExpectedCost(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 10, purple: 20, yellow: 30 },
      100,
      20260509,
      0.75,
      3,
      0.01,
    );

    expect(result?.selected.firstAction).toBe("purple");
    expect(result?.baseline.firstAction).toBe("yellow");
    expect(result?.candidates.map((candidate) => candidate.firstAction)).toEqual([
      "blue",
      "purple",
    ]);
    expect(exports.simulateExpectedFAfterFirstActionFromPolicy).toHaveBeenCalledTimes(2);
    expect(exports.solveCore).toHaveBeenCalledTimes(1);
  });

  it("wraps current-policy first-action E[f] moments behind the current build guard", () => {
    const exports = makeExports();
    const solver = createRustPhase2Solver(exports);

    solver.solveRoot({ grade: "SR", level: 1, exp: 0 }, { blue: 10, purple: 20, yellow: 30 });
    const result = solver.estimateExpectedCostAfterFirstActionFromCurrentWithMoments(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 10, purple: 20, yellow: 30 },
      "blue",
      100,
      20260509,
      0.75,
      3,
    );

    expect(result.expectedCost).toBe(0.456);
    expect(result.runs).toBe(100);
    expect(result.sumSq).toBe(20.8);
    expect(result.variance).toBeCloseTo(20.8 / 100 - 0.456 ** 2, 12);
    expect(result.standardError).toBeCloseTo(Math.sqrt(result.variance / 100), 12);
    expect(exports.simulateExpectedFAfterFirstActionFromPolicy).toHaveBeenCalledOnce();
  });

  it("wraps paired current-policy E[f] rollout and reports exact zero for same-action mocks", () => {
    const exports = makeExports({
      getPairMeanBaseline: vi.fn(() => 0.2),
      getPairMeanSelected: vi.fn(() => 0.2),
      getPairMeanDelta: vi.fn(() => 0),
      getPairDeltaSumSq: vi.fn(() => 0),
      getPairRuns: vi.fn(() => 100),
      getPairCorrelation: vi.fn(() => 0),
    });
    const solver = createRustPhase2Solver(exports);

    solver.solveRoot({ grade: "SR", level: 1, exp: 0 }, { blue: 10, purple: 20, yellow: 30 });
    const result = solver.estimateExpectedCostPairFromCurrent(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 10, purple: 20, yellow: 30 },
      "blue",
      "blue",
      100,
      20260511,
      0.75,
      3,
    );

    expect(result.meanDelta).toBe(0);
    expect(result.deltaVariance).toBe(0);
    expect(result.standardError).toBe(0);
    expect(result.upper95).toBe(0);
    expect(exports.simulateExpectedFPairFromPolicy).toHaveBeenCalledOnce();
  });

  it("wraps current-policy A2 vector moments behind the current build guard", () => {
    const exports = makeExports();
    const solver = createRustPhase2Solver(exports);

    solver.solveRoot({ grade: "SR", level: 1, exp: 0 }, { blue: 10, purple: 20, yellow: 30 });
    const result = solver.estimateA2SurrogateAfterFirstActionFromCurrent(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 10, purple: 20, yellow: 30 },
      "blue",
      0.75,
      3,
    );

    expect(result.mean).toEqual({ blue: 10, purple: 20, yellow: 30 });
    expect(result.covariance).toEqual({
      blueBlue: 100,
      purplePurple: 200,
      yellowYellow: 300,
      bluePurple: 100,
      blueYellow: 100,
      purpleYellow: 200,
    });
    expect(result.baseCost).toBeGreaterThan(0);
    expect(Number.isFinite(result.surrogateCost)).toBe(true);
    expect(result.nodeCount).toBe(42);
    expect(exports.momentVectorAfterFirstActionFromPolicy).toHaveBeenCalledOnce();
  });

  it("wraps current-policy exact E[f] behind the current build guard", () => {
    const exports = makeExports();
    const solver = createRustPhase2Solver(exports);

    solver.solveRoot({ grade: "SR", level: 1, exp: 0 }, { blue: 61, purple: 121, yellow: 901 });
    const result = solver.estimateExactExpectedCostAfterFirstActionFromCurrent(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 61, purple: 121, yellow: 901 },
      "purple",
      0.75,
      3,
    );

    expect(result).toEqual({ expectedCost: 0.321, nodeCount: 24 });
    expect(exports.cvarSetup).toHaveBeenCalledWith(510, 61, 121, 901, 0.75, 3, 0);
    expect(exports.cvarFollowMeanAfterFirstAction).toHaveBeenCalledWith(1);
  });
});
