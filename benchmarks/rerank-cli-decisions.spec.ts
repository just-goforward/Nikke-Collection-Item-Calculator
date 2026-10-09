import { afterEach, describe, expect, it, vi } from "vitest";
import { mockWasmInstantiation } from "./wasm-test-fixture";

const mocks = vi.hoisted(() => ({
  module: vi.fn(),
  writeReport: vi.fn().mockResolvedValue(undefined),
  delta: null as number | null,
  mean: 0,
}));
vi.mock("node:fs/promises", () => ({
  mkdir: async () => {},
  readFile: async () => new Uint8Array(),
}));
vi.mock("vite", () => ({
  createServer: async () => ({ ssrLoadModule: mocks.module, close: async () => {} }),
}));
vi.mock("./runner-utils.ts", async () => ({
  ...(await vi.importActual<typeof import("./runner-utils")>("./runner-utils")),
  envValue: (name: string) => (name === "RUST_RERANK_BENCH_SCENARIOS" ? "fixture" : undefined),
}));
vi.mock("./rust-rerank-benchmark-actions.ts", () => ({
  compareA1ForActions: () => ({ deltaVsBaseline: null }),
  compareA2ForActions: () => ({ deltaVsBaseline: mocks.delta }),
  evaluateAdaptive90Gate: () => ({}),
}));
vi.mock("./rust-rerank-benchmark-report.ts", () => ({
  buildRustRerankBenchmarkReport: (report: unknown) => report,
  writeRustRerankBenchmarkReport: mocks.writeReport,
  rustRerankBenchmarkConsoleSummary: () => ({}),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.clearAllMocks();
});

describe("A2 benchmark gate record without research execution", () => {
  it.each([
    [null, 1, null, null, null],
    [-1, 1, 1, true, false],
    [1, -1, 0, false, true],
    [1, 1, 0, false, false],
  ] as const)(
    "preserves A2 gate delta %s with evaluation %s",
    async (delta, mean, expectedDelta, positive, negative) => {
      mocks.delta = delta;
      mocks.mean = mean;
      const baseline = { firstAction: "blue", successProbability: 1 };
      const selected = {
        firstAction: "purple",
        successProbability: 1,
        probabilityGap: 0,
        expectedCost: 1,
        completionRate: 1,
      };
      const pair = { runs: 1, meanDelta: mean, deltaSumSq: mean * mean, upper95: mean };
      const solver = {
        selectFirstActionByExpectedCost: () => ({
          baseline,
          selected,
          candidates: [{ ...selected, firstAction: "blue" }],
        }),
        estimateExpectedCostAfterFirstActionFromCurrent: () => selected,
        estimateExpectedCostPairFromCurrent: () => pair,
        selectFirstActionByExactExpectedCost: () => null,
      };
      const modules: Record<string, unknown> = {
        "rustResearchLoader.ts": { createRustPhase2ResearchSolverFromInstance: () => solver },
        "rustLoader.ts": { rustCoreExportsFromInstance: () => ({}) },
        "rustMinEfCore.ts": {
          createRustMinEfSolver: () => ({
            solveRootWithCandidates: () => ({
              root: {
                ...baseline,
                vector: { blue: 0, purple: 0, yellow: 0 },
                expectedCost: 1,
              },
            }),
          }),
        },
        "rustStatus.ts": { RustSolveError: class extends Error {} },
        "fixed-grid.ts": {
          FIXED_SAFETY_GRID: [
            {
              id: "fixture",
              group: "scarcity",
              start: { grade: "R", level: 0 },
              stock: { blue: 10, purple: 10, yellow: 10 },
            },
          ],
        },
        "rerank-supplemental.ts": { RERANK_SUPPLEMENTAL_SCENARIOS: [] },
        "rerank-product.ts": { PRODUCT_RERANK_SCENARIOS: [] },
      };
      mocks.module.mockImplementation(
        async (path: string) => modules[path.split("/").at(-1) ?? ""],
      );
      vi.spyOn(console, "log").mockImplementation(() => {});
      mockWasmInstantiation();
      await import("./run-rust-rerank-benchmark");
      expect(mocks.writeReport).toHaveBeenCalledOnce();
      const call = mocks.writeReport.mock.calls[0];
      if (!call) throw new Error("Missing report write.");
      const { report } = call[0] as {
        report: { records: unknown[] };
      };
      expect(report.records).toHaveLength(1);
      expect(report.records[0]).toMatchObject({
        status: "completed",
        a2GateEvaluationDeltaVsBaseline: expectedDelta,
        a2GateFalsePositive: positive,
        a2GateFalseNegative: negative,
      });
    },
  );
});
