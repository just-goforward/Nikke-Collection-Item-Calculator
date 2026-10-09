import { afterEach, describe, expect, it, vi } from "vitest";
import { mockWasmInstantiation } from "./wasm-test-fixture";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  module: vi.fn(),
  release: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile, writeFile: mocks.writeFile }));
vi.mock("vite", () => ({
  createServer: async () => ({ ssrLoadModule: mocks.module, close: async () => {} }),
}));
vi.mock("./research-provenance.ts", () => ({
  collectResearchProvenance: () => ({}),
  assertResearchReportCanBeWritten: vi.fn(),
  fingerprintResearchArtifact: () => ({ sha256: "fixture" }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.clearAllMocks();
});

function setup() {
  mocks.readFile.mockImplementation(async (url: URL) => {
    if (url.pathname.endsWith(".wasm")) return new Uint8Array();
    throw Object.assign(new Error("No existing report"), { code: "ENOENT" });
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockWasmInstantiation();
}

async function writtenReport() {
  await vi.waitFor(() => expect(mocks.writeFile).toHaveBeenCalledOnce());
  return JSON.parse(mocks.writeFile.mock.calls[0]?.[1] as string);
}

describe("policy campaign decisions without research execution", () => {
  it.each([
    ["invalid", { outcome: "failure" }, "none"],
    ["discovery_order", { success: 0.8 }, "discovery_order"],
    ["max_path_probability", { success: 1 }, "max_path_probability"],
    ["max_path_probability", { cost: 1 }, "max_path_probability"],
    ["discovery_order", { cost: 3 }, "discovery_order"],
    ["tie", {}, "none"],
  ])("preserves priority verdict %s for %j", async (verdict, variation, winner) => {
    setup();
    const reference = {
      firstAction: "blue",
      successProbability: 0.9,
      expectedCost: 2,
      vector: { blue: 0, purple: 0, yellow: 0 },
    };
    const modules: Record<string, unknown> = {
      "rustLoader.ts": { rustCoreExportsFromInstance: () => ({}) },
      "rustMinEfCore.ts": {
        createRustMinEfSolver: () => ({
          solveRootWithCandidates: () => ({ root: reference }),
        }),
      },
      "rustPhase2ResearchCore.ts": {
        createRustPhase2ResearchSolver: () => ({
          configureMemoTier: vi.fn(),
          solveRoot: () => reference,
        }),
      },
      "rust-prioritized-sparse-pi.ts": {
        solveRustPrioritizedSparsePi: (
          _exports: unknown,
          _input: unknown,
          options: { maxUpdatesPerPass: number; priorityMode: string },
        ) => ({
          outcome: options.maxUpdatesPerPass === 256 ? "iteration_budget_exceeded" : "completed",
          finalAction: "blue",
          success: 0.9,
          cost: 2,
          initialSuccess: 0.7,
          initialCost: 4,
          vector: reference.vector,
          probabilityGap: 0,
          successInvariantChecks: 1,
          successInvariantMaxGap: 0,
          finalPassStates: 1,
          finalPassScanned: 1,
          ...(options.maxUpdatesPerPass === 256 && options.priorityMode === "max_path_probability"
            ? variation
            : {}),
        }),
      },
      "fixed-grid.ts": {
        FIXED_SAFETY_GRID: [
          "R14e900-yellow30",
          "SR5-blue30",
          "SR10-yellow10",
          "R10-balanced300",
          "SR0-balanced300",
        ].map((id) => ({
          id,
          start: { grade: "R", level: 0 },
          stock: { blue: 10, purple: 10, yellow: 10 },
        })),
      },
    };
    mocks.module.mockImplementation(async (path: string) => modules[path.split("/").at(-1) ?? ""]);
    await import("./run-prioritized-policy-study");
    const report = await writtenReport();
    expect(
      report.priorityRecords.map(
        (record: { comparison: { verdict: string } }) => record.comparison.verdict,
      ),
    ).toEqual([verdict, verdict, verdict]);
    expect(report.decision.priorityWinner).toBe(winner);
  });

  it.each([
    ["verification_incomplete", "verification_incomplete", "scenario_pass", 5],
    ["interaction_policy_tradeoff", "completed", "scenario_pass", 5],
    ["rejected", "completed", "scenario_rejected", 5],
    ["rejected", "completed", "scenario_pass", 10],
  ])("preserves batching classification %s", async (classification, status, grade, entries) => {
    setup();
    const baseline = {
      status: "completed",
      expectedManualEntries: 10,
      manualEntryProbability: 1,
      successAttemptSelectionProbability: 1,
      solveCalls: 1,
      cachedNodes: 1,
    };
    const scenarioIds = ["R10-balanced300", "SR0-balanced300"];
    const stored = {
      kind: "bounded-hybrid-quality-study",
      productWasm: { sha256: "fixture" },
      records: scenarioIds.map((scenarioId) => ({ scenarioId, baseline })),
    };
    const read = mocks.readFile.getMockImplementation();
    mocks.readFile.mockImplementation(async (url: URL) =>
      url.pathname.endsWith("bounded-hybrid-quality-study-v1.json")
        ? JSON.stringify(stored)
        : read?.(url),
    );
    const modules: Record<string, unknown> = {
      "exact-replan.ts": {
        evaluateExactInteractiveReplan: () => ({
          ...baseline,
          status,
          expectedManualEntries: entries,
          solveCalls: 3,
        }),
      },
      "min-ef-hp-model.ts": { hpCandidateById: () => ({}) },
      "min-ef-hp-policy.ts": {
        createHpLadderSession: () => ({
          policySolver: () => {
            throw new Error("Research solves must not execute.");
          },
          release: mocks.release,
        }),
      },
      "single-use-batching.ts": { forceSingleUseBatching: (solver: unknown) => solver },
      "bounded-hybrid-quality.ts": {
        classifyBoundedHybridQuality: () => ({ grade, reasons: ["fixture"] }),
      },
      "fixed-grid.ts": { FIXED_SAFETY_GRID: scenarioIds.map((id) => ({ id })) },
    };
    mocks.module.mockImplementation(async (path: string) => modules[path.split("/").at(-1) ?? ""]);
    await import("./run-single-use-batching-study");
    const report = await writtenReport();
    expect(report.decision).toMatchObject({
      classification,
      resourceQualityGatePassed: grade === "scenario_pass",
      manualEntryReductionObserved: status === "completed" && entries < 10,
      productAdoptionAuthorized: false,
      interactionWorkloadMeasured: false,
    });
    expect(mocks.release).toHaveBeenCalledTimes(2);
    expect(report.records[0].deltas.solveCalls).toBe(2);
    expect(report.decision.blockers.at(-1)).toBe(
      "Expected user confirmation/recalculation workload is not measured by the exact evaluator.",
    );
  });
});
