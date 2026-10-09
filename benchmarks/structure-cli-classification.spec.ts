import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  module: vi.fn(),
  write: vi.fn(),
  exec: vi.fn(() => "fixture"),
  remove: vi.fn(),
  action: "blue",
  patterns: 0,
  monotone: true,
}));
vi.mock("node:fs", () => ({
  readFileSync: () => "fixture",
  writeFileSync: mocks.write,
  mkdirSync: vi.fn(),
  rmSync: mocks.remove,
}));
vi.mock("node:child_process", () => ({ execFileSync: mocks.exec }));
vi.mock("vite", () => ({
  createServer: async () => ({ ssrLoadModule: mocks.module, close: async () => {} }),
}));
vi.mock("./research-provenance.ts", () => ({
  collectResearchProvenance: () => ({}),
  readOptionalResearchReport: () => null,
  assertResearchReportCanBeWritten: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

function setup() {
  const modules: Record<string, unknown> = {
    "compact-exact-graph.ts": {
      buildCompactStateGraph: () => ({
        outcome: "completed",
        graph: { nodes: [{}], edgeCount: 1 },
      }),
      solveCompactMinEf: () => ({
        root: {
          action: "blue",
          successProbability: 1,
          expectedCost: 1,
          vector: { blue: 1, purple: 0, yellow: 0 },
        },
      }),
    },
    "compact-lp-oracle.ts": {
      exportCompactOccupancyMps: () => ({ text: "fixture" }),
      exportMaximumReachabilityMps: () => ({ text: "fixture" }),
      parseHighsSolution: () => ({
        objective: 1,
        modelStatus: "Optimal",
        primalStatus: "Feasible",
      }),
      rootActionFromSolution: () => mocks.action,
    },
    "pareto-frontier-dp.ts": {
      solveParetoFrontiers: () => ({ outcome: "completed", p95Width: 1 }),
    },
    "symbolic-compression-screen.ts": {
      screenExactSymbolicCompression: () => ({
        exactValueMismatches: 0,
        reduction: 0.5,
      }),
    },
    "monotonicity-screen.ts": {
      successIsMonotone: () => mocks.monotone,
      findReentrantActionPatterns: () => Array.from({ length: mocks.patterns }, () => ({})),
    },
  };
  mocks.module.mockImplementation(async (path: string) => modules[path.split("/").at(-1) ?? ""]);
  vi.spyOn(console, "log").mockImplementation(() => {});
}

function report() {
  return JSON.parse(mocks.write.mock.calls.at(-1)?.[1] as string);
}

describe("structure CLI classifications without research or external solver execution", () => {
  it.each([
    [false, "blue", "verification_incomplete"],
    [true, "purple", "failure"],
    [true, "blue", "completed"],
  ])("preserves LP aggregate %s/%s", async (available, action, outcome) => {
    setup();
    mocks.action = action;
    vi.stubEnv("HIGHS_PATH", available ? "fixture-highs" : undefined);
    await import("./run-compact-lp-oracle");
    expect(report().outcome).toBe(outcome);
    expect(report().scenarios).toHaveLength(3);
    expect(mocks.exec).toHaveBeenCalledTimes(available ? 10 : 0);
    expect(mocks.remove).toHaveBeenCalledTimes(available ? 9 : 0);
  });

  it.each([
    [
      1,
      false,
      "Sampled inventory lines contain re-entrant actions, refuting a simple threshold policy.",
    ],
    [0, false, "A sampled success-probability monotonicity check failed."],
    [0, true, "No sampled counterexample is not a global monotonicity proof."],
  ])("preserves monotonicity reason precedence %s/%s", async (patterns, monotone, reason) => {
    setup();
    mocks.patterns = patterns;
    mocks.monotone = monotone;
    await import("./run-structure-candidate-screen");
    expect(report().monotonicity).toMatchObject({
      reentrantPatternCount: patterns * 6,
      monotonicityViolationCount: monotone ? 0 : 6,
      adoption: { reason, grade: patterns || !monotone ? "rejected" : "verification_incomplete" },
    });
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
