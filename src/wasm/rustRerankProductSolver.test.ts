import { afterEach, describe, expect, it, vi } from "vitest";
import type { Kit } from "../types";
import type { State, Stock } from "./rustTypes";

const mocks = vi.hoisted(() => ({ solver: vi.fn(), decision: vi.fn() }));
vi.mock("./rustResearchSolverCache", () => ({ getRustPhase2ResearchSolver: mocks.solver }));
vi.mock("./rustRerankDecision", () => ({ selectAdaptiveRerankDecision: mocks.decision }));

import { solveRustPhase2Rerank } from "./rustRerankProductSolver";

const input = {
  start: { grade: "SR" as const, level: 14, exp: 2900 },
  stock: { blue: 10, purple: 20, yellow: 30 },
  strategy: "supply" as const,
};

function fixture(baselineAction: Kit | null) {
  const baseline = {
    firstAction: baselineAction,
    successProbability: 0.8,
    maxSuccessProbability: 0.9,
    vector: { blue: 11, purple: 22, yellow: 33 },
    states: 1234,
  };
  const selected = {
    firstAction: "blue" as const,
    successProbability: 0.9,
    maxSuccessProbability: 0.9,
    probabilityGap: 0,
    vector: { blue: 10, purple: 20, yellow: 30 },
    resourceCost: 0.3,
    eligible: true,
    expectedCost: 0.2,
    completionRate: 1,
  };
  const estimate = vi.fn((_start: State, _stock: Stock, action: Kit) => ({
    expectedCost: action === "blue" ? 0.2 : 0.4,
    completionRate: 1,
  }));
  const solver = {
    setSupplyForecast: vi.fn(),
    estimateExpectedCostAfterFirstActionFromCurrent: estimate,
  };
  mocks.solver.mockResolvedValue(solver);
  mocks.decision.mockReturnValue({
    rerank: {
      baseline,
      selected,
      candidates: [selected],
      policy: { actionAt: () => "purple" },
    },
    rawSelected: selected,
    selected,
    gatePair: null,
    gatePass: true,
    gateRuns: 0,
    gateUpperBound: null,
  });
  return { estimate };
}

afterEach(() => {
  mocks.solver.mockReset();
  mocks.decision.mockReset();
});

describe("research rerank product result contract", () => {
  it.each(["blue", "yellow", null] as const)(
    "preserves held-out selection and result fields for baseline %s",
    async (baselineAction) => {
      const { estimate } = fixture(baselineAction);
      const progress = vi.fn();
      const result = await solveRustPhase2Rerank(input, "/solver.wasm", progress);
      let baselineCost: number | null = null;
      if (baselineAction === "blue") baselineCost = 0.2;
      else if (baselineAction === "yellow") baselineCost = 0.4;

      expect(estimate.mock.calls.map((call) => call[2])).toEqual(
        baselineAction === "yellow" ? ["blue", "yellow"] : ["blue"],
      );
      expect(Object.keys(result).sort()).toEqual([
        "best",
        "candidateCount",
        "input",
        "monteCarlo",
        "possible",
        "route",
        "stats",
        "terminal",
        "topCandidates",
      ]);
      expect(result).toMatchObject({
        possible: true,
        terminal: false,
        candidateCount: 1,
        best: {
          name: "Rust phase2 rerank adaptive90 m0.00025 confirm",
          firstAction: "blue",
          vector: { blue: 10, purple: 20, yellow: 30 },
          totalKits: 60,
          successProbability: 0.9,
          maxSuccessProbability: 0.9,
          probabilityGap: 0,
          resourceCost: 0.2,
        },
        monteCarlo: {
          runs: 0,
          completed: 0,
          successProbability: 0.9,
          vector: { blue: 0, purple: 0, yellow: 0 },
        },
        stats: {
          states: 1234,
          exact: true,
          tolerance: 0,
          probabilityTolerance: 0,
          maxSuccessProbability: 0.9,
          strategy: "supply",
          solverBackend: "rust-phase2-rerank",
          solverPhase: "phase2-rerank",
          rustRerank: {
            runs: 512,
            maxRuns: 2048,
            seed: 20260509,
            gate: "adaptive90",
            gateZ: 1.645,
            gateQuickAcceptMargin: -0.001,
            gateFullAcceptMargin: -0.00025,
            gateRuns: 0,
            gateSeed: 20260510,
            gatePass: true,
            gateMeanDelta: null,
            gateStandardError: null,
            gateUpper95: null,
            gateUpperBound: null,
            gateCorrelation: null,
            rawSelectedFirstAction: "blue",
            rawExpectedCost: 0.2,
            rawCompletionRate: 1,
            expectedCost: 0.2,
            completionRate: 1,
            heldOutSeed: 20260510,
            heldOutExpectedCost: 0.2,
            heldOutCompletionRate: 1,
            heldOutBaselineExpectedCost: baselineCost,
            heldOutBaselineCompletionRate: baselineAction === null ? null : 1,
            heldOutDeltaVsBaseline: baselineCost === null ? null : 0.2 - baselineCost,
            heldOutBeatsBaseline: baselineCost === null ? null : true,
            baselineFirstAction: baselineAction,
            baselineSuccessProbability: 0.8,
          },
          iterations: 0,
        },
        topCandidates: [
          {
            firstAction: "blue",
            vector: { blue: 10, purple: 20, yellow: 30 },
            totalKits: 60,
            successProbability: 0.9,
            probabilityGap: 0,
            resourceCost: 0.2,
            rerankExpectedCost: 0.2,
            rerankCompletionRate: 1,
          },
        ],
      });
      expect(progress.mock.calls.map((call) => call[0])).toEqual([
        { phase: "build", scanned: 0, total: 1 },
        { phase: "done", scanned: 1234, total: 1234 },
      ]);
    },
  );

  it("preserves no-action results without held-out work", async () => {
    const { estimate } = fixture("blue");
    mocks.decision.mockReturnValue(null);
    expect(await solveRustPhase2Rerank(input, "/solver.wasm")).toMatchObject({
      possible: false,
      message: "현재 보유 키트로 가능한 행동이 없습니다.",
    });
    expect(estimate).not.toHaveBeenCalled();
  });

  it("propagates held-out failures before emitting done progress", async () => {
    const { estimate } = fixture("yellow");
    const error = new Error("held-out failed");
    estimate.mockImplementation(() => {
      throw error;
    });
    const progress = vi.fn();
    await expect(solveRustPhase2Rerank(input, "/solver.wasm", progress)).rejects.toBe(error);
    expect(progress.mock.calls.map((call) => call[0])).toEqual([
      { phase: "build", scanned: 0, total: 1 },
    ]);
  });
});
