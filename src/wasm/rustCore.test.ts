import { describe, expect, it, vi } from "vitest";

import {
  createRustMinEfSolver,
  createRustPhase2Solver,
  isMemoFull,
  type RustCoreExports,
} from "./rustCore";

function makeExports(overrides: Partial<RustCoreExports> = {}): RustCoreExports {
  return {
    configureMemo: vi.fn(),
    configureNodeBudget: vi.fn(),
    getSolveStatus: vi.fn(() => 0),
    solveMinEf: vi.fn(),
    solveCore: vi.fn(() => 7),
    resAction: vi.fn(() => 2),
    resSuccessProb: vi.fn(() => 0.8),
    resMaxSuccessProb: vi.fn(() => 0.82),
    resVecB: vi.fn(() => 11),
    resVecP: vi.fn(() => 22),
    resVecY: vi.fn(() => 33),
    rootCandidateValid: vi.fn((action: number) => (action === 1 ? 0 : 1)),
    rootCandidateMaxSuccessProb: vi.fn(() => 0.9),
    rootCandidateSuccessProb: vi.fn((action: number) => (action === 0 ? 0.9 : 0.895)),
    rootCandidateVecB: vi.fn((action: number) => 10 + action),
    rootCandidateVecP: vi.fn((action: number) => 20 + action),
    rootCandidateVecY: vi.fn((action: number) => 30 + action),
    rootCandidateCost: vi.fn((action: number) => 0.1 + action),
    policyActionAt: vi.fn(() => 1),
    simulateCore: vi.fn(),
    simulateAfterFirstActionCore: vi.fn(),
    getMcCompleted: vi.fn(() => 80),
    getMcRuns: vi.fn(() => 100),
    getMcVecB: vi.fn(() => 1),
    getMcVecP: vi.fn(() => 2),
    getMcVecY: vi.fn(() => 3),
    statesCount: vi.fn(() => 1234),
    minEfAction: vi.fn(() => 0),
    minEfSuccessProb: vi.fn(() => 0.9),
    minEfMaxSuccessProb: vi.fn(() => 0.95),
    minEfVecB: vi.fn(() => 10),
    minEfVecP: vi.fn(() => 20),
    minEfVecY: vi.fn(() => 30),
    minEfExpectedCost: vi.fn(() => 0.123),
    minEfRootCandidateValid: vi.fn((action: number) => (action === 1 ? 0 : 1)),
    minEfRootCandidateMaxSuccessProb: vi.fn(() => 0.95),
    minEfRootCandidateSuccessProb: vi.fn((action: number) => (action === 0 ? 0.95 : 0.94)),
    minEfRootCandidateVecB: vi.fn((action: number) => 10 + action),
    minEfRootCandidateVecP: vi.fn((action: number) => 20 + action),
    minEfRootCandidateVecY: vi.fn((action: number) => 30 + action),
    minEfRootCandidateExpectedCost: vi.fn((action: number) => 0.1 + action),
    minEfActionAtOrSolve: vi.fn(() => 1),
    simulateExpectedFAfterFirstAction: vi.fn(),
    simulateExpectedFAfterFirstActionFromPolicy: vi.fn(),
    simulateExpectedFPairFromPolicy: vi.fn(),
    getMcEf: vi.fn(() => 0.456),
    getMcEfSumSq: vi.fn(() => 20.8),
    getMcEfRuns: vi.fn(() => 100),
    getMcEfCompletion: vi.fn(() => 0.99),
    getPairMeanBaseline: vi.fn(() => 0.2),
    getPairMeanSelected: vi.fn(() => 0.1),
    getPairMeanDelta: vi.fn(() => -0.1),
    getPairDeltaSumSq: vi.fn(() => 2),
    getPairRuns: vi.fn(() => 100),
    getPairCorrelation: vi.fn(() => 0.5),
    momentVectorAfterFirstActionFromPolicy: vi.fn(),
    momentMeanBUses: vi.fn(() => 1),
    momentMeanPUses: vi.fn(() => 2),
    momentMeanYUses: vi.fn(() => 3),
    momentSecondBBUses: vi.fn(() => 2),
    momentSecondPPUses: vi.fn(() => 6),
    momentSecondYYUses: vi.fn(() => 12),
    momentSecondBPUses: vi.fn(() => 3),
    momentSecondBYUses: vi.fn(() => 4),
    momentSecondPYUses: vi.fn(() => 8),
    momentVectorNodeCount: vi.fn(() => 42),
    cvarSetup: vi.fn(),
    cvarFollowMeanAfterFirstAction: vi.fn(() => 0.321),
    cvarNodeCount: vi.fn(() => 24),
    ...overrides,
  };
}

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

  it("wraps phase2 solveCore results", () => {
    const solver = createRustPhase2Solver(makeExports());

    expect(
      solver.solveRoot({ grade: "SR", level: 1, exp: 0 }, { blue: 10, purple: 20, yellow: 30 }),
    ).toEqual({
      firstAction: "yellow",
      successProbability: 0.8,
      maxSuccessProbability: 0.82,
      vector: { blue: 11, purple: 22, yellow: 33 },
      states: 1234,
    });
  });

  it("throws on phase2 status before reading result accessors", () => {
    const exports = makeExports({
      getSolveStatus: vi.fn(() => 2),
      resAction: vi.fn(() => {
        throw new Error("phase2 accessor should not be read");
      }),
    });
    const solver = createRustPhase2Solver(exports);

    expect(() =>
      solver.solveRoot({ grade: "SR", level: 1, exp: 0 }, { blue: 10, purple: 10, yellow: 10 }),
    ).toThrow("memo_full");
    expect(exports.resAction).not.toHaveBeenCalled();
  });

  it("treats phase2 depleted sentinel as a normal no-action result", () => {
    const solver = createRustPhase2Solver(
      makeExports({
        solveCore: vi.fn(() => -3),
        resAction: vi.fn(() => -1),
        resSuccessProb: vi.fn(() => 0),
        resMaxSuccessProb: vi.fn(() => 0),
        resVecB: vi.fn(() => 0),
        resVecP: vi.fn(() => 0),
        resVecY: vi.fn(() => 0),
      }),
    );

    expect(
      solver.solveRoot({ grade: "R", level: 0, exp: 0 }, { blue: 0, purple: 0, yellow: 0 }),
    ).toEqual({
      firstAction: null,
      successProbability: 0,
      maxSuccessProbability: 0,
      vector: { blue: 0, purple: 0, yellow: 0 },
      states: 1234,
    });
  });

  it("reads exact phase2 root candidates after solving", () => {
    const exports = makeExports();
    const solver = createRustPhase2Solver(exports);

    expect(
      solver.rootCandidates(
        { grade: "SR", level: 1, exp: 0 },
        { blue: 10, purple: 20, yellow: 30 },
      ),
    ).toEqual([
      {
        firstAction: "blue",
        successProbability: 0.9,
        maxSuccessProbability: 0.9,
        probabilityGap: 0,
        vector: { blue: 10, purple: 20, yellow: 30 },
        resourceCost: 0.1,
        eligible: true,
      },
      {
        firstAction: "yellow",
        successProbability: 0.895,
        maxSuccessProbability: 0.9,
        probabilityGap: 0.0050000000000000044,
        vector: { blue: 12, purple: 22, yellow: 32 },
        resourceCost: 2.1,
        eligible: false,
      },
    ]);
    expect(exports.solveCore).toHaveBeenCalled();
  });

  it("does not read root candidates when phase2 candidate solve fails", () => {
    const exports = makeExports({
      getSolveStatus: vi.fn(() => 2),
      rootCandidateValid: vi.fn(() => {
        throw new Error("candidate getter should not be read");
      }),
    });
    const solver = createRustPhase2Solver(exports);

    expect(() =>
      solver.rootCandidates(
        { grade: "SR", level: 1, exp: 0 },
        { blue: 10, purple: 10, yellow: 10 },
      ),
    ).toThrow("memo_full");
    expect(exports.rootCandidateValid).not.toHaveBeenCalled();
  });

  it("wraps phase2 first-action E[f] simulation", () => {
    const exports = makeExports();
    const solver = createRustPhase2Solver(exports);

    expect(
      solver.estimateExpectedCostAfterFirstAction(
        { grade: "SR", level: 1, exp: 200 },
        { blue: 25, purple: 35, yellow: 45 },
        "purple",
        1200,
        20260509,
      ),
    ).toEqual({ expectedCost: 0.456, completionRate: 0.99 });

    expect(exports.simulateExpectedFAfterFirstAction).toHaveBeenCalledWith(
      512,
      2,
      3,
      4,
      25,
      35,
      45,
      0.75,
      3,
      0,
      1200,
      20260509,
      1,
    );
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
        lastAction = args[12];
      }),
      simulateExpectedFAfterFirstActionFromPolicy: vi.fn((...args: number[]) => {
        lastAction = args[11];
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

    solver.solveRoot({ grade: "SR", level: 1, exp: 0 }, { blue: 10, purple: 20, yellow: 30 });
    const result = solver.estimateExactExpectedCostAfterFirstActionFromCurrent(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 10, purple: 20, yellow: 30 },
      "purple",
      0.75,
      3,
    );

    expect(result).toEqual({ expectedCost: 0.321, nodeCount: 24 });
    expect(exports.cvarSetup).toHaveBeenCalledOnce();
    expect(exports.cvarFollowMeanAfterFirstAction).toHaveBeenCalledWith(1);
  });
});
