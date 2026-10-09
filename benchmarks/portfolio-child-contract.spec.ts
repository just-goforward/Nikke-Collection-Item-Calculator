import { afterEach, describe, expect, it, vi } from "vitest";
import { mockWasmInstantiation } from "./wasm-test-fixture";

const mocks = vi.hoisted(() => ({
  read: vi.fn().mockResolvedValue(new Uint8Array()),
  module: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.read, writeFile: vi.fn() }));
vi.mock("vite", () => ({
  createServer: async () => ({ ssrLoadModule: mocks.module, close: async () => {} }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe("portfolio child artifact selection without research execution", () => {
  it.each([
    ["min-ef-tier21", "public/solver_rs.wasm"],
    ["branch-bound-b2-tier22", "output/solver_rs-branch-bound-audit.wasm"],
    ["bounded-prioritized-phase2", "output/solver_rs-prioritized-sparse-pi.wasm"],
  ])("preserves %s artifact and result", async (arm, path) => {
    const scenario = {
      id: "fixture",
      start: { grade: "R", level: 0 },
      stock: { blue: 10, purple: 10, yellow: 10 },
    };
    const originalArgv = process.argv;
    process.argv = [
      originalArgv[0] ?? "",
      originalArgv[1] ?? "",
      "--child",
      arm,
      Buffer.from(JSON.stringify(scenario)).toString("base64url"),
    ];
    try {
      const root = {
        firstAction: "blue",
        expectedCost: 1,
        successProbability: 1,
        maxSuccessProbability: 1,
        vector: { blue: 10, purple: 0, yellow: 0 },
      };
      const exports = {
        configureMinEfBranchBoundSuccessMemo: vi.fn(),
        configureMinEfBranchBoundPruning: () => 1,
        minEfBranchBoundAppliedPrunes: () => 0,
        minEfBranchBoundOracleStates: () => 0,
        minEfBranchBoundPrepassMismatches: () => 0,
      };
      const modules: Record<string, unknown> = {
        "rustLoader.ts": { rustCoreExportsFromInstance: () => exports },
        "rustMinEfCore.ts": {
          createRustMinEfSolver: () => ({
            configureMemoTier: vi.fn(),
            solveRootWithCandidates: () => ({ root, nodeCount: 1 }),
          }),
        },
        "rust-prioritized-sparse-pi.ts": {
          solveRustPrioritizedSparsePi: () => ({
            outcome: "iteration_budget_exceeded",
            finalAction: "blue",
            cost: 1,
            success: 1,
            probabilityGap: 0,
            vector: root.vector,
            scannedStates: 1,
          }),
        },
      };
      mocks.module.mockImplementation(
        async (name: string) => modules[name.split("/").at(-1) ?? ""],
      );
      mockWasmInstantiation({ memory: new WebAssembly.Memory({ initial: 1 }) });
      const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await import("./run-solver-portfolio-study");
      expect(String(mocks.read.mock.calls[0]?.[0]).replaceAll("\\", "/")).toMatch(
        new RegExp(`${path.replaceAll(".", "\\.")}$`),
      );
      expect(write).toHaveBeenCalledOnce();
      const record = JSON.parse(
        String(write.mock.calls[0]?.[0]).slice("SOLVER_PORTFOLIO_RECORD:".length),
      );
      expect(record).toMatchObject({
        arm,
        scenarioId: "fixture",
        outcome: "completed",
        nodeCount: 1,
        semantic: { action: "blue", expectedCost: 1, successProbability: 1, vector: root.vector },
      });
    } finally {
      process.argv = originalArgv;
    }
  });
});
