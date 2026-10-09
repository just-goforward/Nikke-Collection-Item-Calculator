import { afterEach, describe, expect, it, vi } from "vitest";
import { mockWasmInstantiation } from "./wasm-test-fixture";

const mocks = vi.hoisted(() => ({
  module: vi.fn(),
  write: vi.fn().mockResolvedValue(undefined),
  env: {} as Record<string, string>,
}));
vi.mock("node:fs/promises", () => ({
  mkdir: async () => {},
  readFile: async () => new Uint8Array(),
  writeFile: mocks.write,
}));
vi.mock("vite", () => ({
  createServer: async () => ({ ssrLoadModule: mocks.module, close: async () => {} }),
}));
vi.mock("./runner-utils", async () => ({
  ...(await vi.importActual<typeof import("./runner-utils")>("./runner-utils")),
  envValue: (name: string) => mocks.env[name],
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.clearAllMocks();
});

function setup(extra: Record<string, unknown>) {
  const fixture = {
    id: "fixture",
    group: "scarcity",
    start: { grade: "R", level: 10, exp: 100 },
    stock: { blue: 10, purple: 20, yellow: 30 },
  };
  const modules: Record<string, unknown> = {
    "fixed-grid.ts": { FIXED_SAFETY_GRID: [fixture] },
    "rerank-supplemental.ts": {
      RERANK_SUPPLEMENTAL_SCENARIOS: [],
      rerankSupplementalScenarioById: () => fixture,
    },
    "rerank-product.ts": { PRODUCT_RERANK_SCENARIOS: [] },
    ...extra,
  };
  mocks.module.mockImplementation(async (path: string) => modules[path.split("/").at(-1) ?? ""]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockWasmInstantiation();
}

describe("runner contracts without solver execution", () => {
  it("preserves runtime parsing and CSV quoting", async () => {
    mocks.env = {
      RUST_RUNTIME_BENCH_SCENARIOS: " fixture ",
      RUST_RUNTIME_BENCH_BACKENDS: "unknown,js-phase2",
      RUST_RUNTIME_BENCH_REPEATS: "1.8",
      RUST_RUNTIME_BENCH_MC_RUNS: "0",
    };
    const solve = vi.fn(() => ({
      possible: true,
      best: { firstAction: 'blue,"quote"\n', successProbability: 1 },
    }));
    setup({ "solve.ts": { solveWithResearchCostModel: solve } });
    await import("./run-rust-runtime-benchmark");
    const report = JSON.parse(mocks.write.mock.calls[0]?.[1] as string);
    expect(report.options).toMatchObject({
      repeats: 1,
      monteCarloRuns: 0,
      backends: ["js-phase2"],
      scenarioIds: ["fixture"],
    });
    expect(report.records).toHaveLength(1);
    expect(report.records[0]).toMatchObject({ status: "completed", backend: "js-phase2" });
    expect(solve).toHaveBeenCalledTimes(2);
    expect(mocks.write.mock.calls[1]?.[1]).toContain('"blue,""quote""\n"');
  });

  it("preserves supplemental no-action records and state labels", async () => {
    mocks.env = {
      RUST_RERANK_SUPPLEMENTAL_SCENARIOS: "fixture",
      RUST_RERANK_SUPPLEMENTAL_RUNS: "2.9",
    };
    setup({
      "rustResearchLoader.ts": {
        createRustPhase2ResearchSolverFromInstance: () => ({
          selectFirstActionByExpectedCost: () => null,
        }),
      },
    });
    await import("./run-rust-rerank-supplemental");
    const report = JSON.parse(mocks.write.mock.calls[0]?.[1] as string);
    expect(report.options.runs).toBe(2);
    expect(report.records).toHaveLength(1);
    expect(report.records[0]).toMatchObject({
      status: "no-action",
      start: "R10e100",
      candidateCount: 0,
      heldOutDeltaVsBaseline: null,
    });
    expect(report.summary).toMatchObject({ noActionCount: 1, completedCount: 0 });
    expect(mocks.write).toHaveBeenCalledTimes(2);
  });

  it.each([
    [1, "budget_exceeded"],
    [2, "memo_full"],
    [3, "failure"],
  ] as const)("preserves root failure status %s", async (status, outcome) => {
    mocks.env = { SOLVER_QUALITY_SCENARIOS: "fixture" };
    const fail = () => {
      throw Object.assign(new Error("fixture failure"), { status });
    };
    setup({
      "rustResearchLoader.ts": { createRustPhase2ResearchSolverFromInstance: () => ({}) },
      "rust-policy-solvers.ts": {
        createRustPolicySolvers: () => ({
          phase2_baseline: fail,
          phase2_mc_rerank: fail,
          phase2_exact_rerank: fail,
        }),
      },
      "exact-replan.ts": { evaluateExactInteractiveReplan: () => ({ status: "solver_failure" }) },
      "rerank-quality.ts": {
        passesQualityLatencyGate: () => false,
        classifyExactInteractiveCandidate: () => "verification_incomplete",
        classifyExactInteractiveCandidateSet: () => "verification_incomplete",
      },
    });
    await import("./run-solver-policy-quality");
    const report = JSON.parse(mocks.write.mock.calls[0]?.[1] as string);
    for (const latency of Object.values(report.records[0].latencies)) {
      expect(latency).toMatchObject({ outcome, error: "fixture failure", repeats: 1 });
    }
    expect(report.decisionScope.productAdoptionAuthorized).toBe(false);
  });
});
