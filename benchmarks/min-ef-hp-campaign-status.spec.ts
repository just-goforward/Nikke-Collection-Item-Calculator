import { afterEach, describe, expect, it, vi } from "vitest";
import { mockWasmInstantiation } from "./wasm-test-fixture";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  rm: vi.fn().mockResolvedValue(undefined),
  readReport: vi.fn(),
  writeReport: vi.fn().mockResolvedValue(undefined),
  module: vi.fn(),
  phase: "discovery",
}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile, rm: mocks.rm }));
vi.mock("vite", () => ({
  createServer: async () => ({ ssrLoadModule: mocks.module, close: async () => {} }),
}));
vi.mock("./min-ef-hp-report", () => ({
  readHpStudyReport: mocks.readReport,
  writeHpStudyReport: mocks.writeReport,
  readExactCheckpoint: async () => undefined,
  writeExactCheckpoint: async () => {},
  shouldAdvanceExactEvaluation: () => false,
  summarizeLadderTraces: () => ({}),
}));
vi.mock("./runner-utils", async () => ({
  ...(await vi.importActual<typeof import("./runner-utils")>("./runner-utils")),
  envValue: (name: string) => (name === "HP_STUDY_TAIL_PHASE" ? mocks.phase : undefined),
}));

function report() {
  return {
    options: { supplyForecast: { forecastProfileId: "fixture" } },
    baselineVerification: { candidateId: "baseline" },
    exact: { complete: true, finalistIds: ["baseline", "candidate"] },
    tailRisk: {
      status: "completed",
      records: [] as unknown[],
      confirmationDecisions: [{ candidateId: "candidate", passed: true }],
    },
    d1Robustness: { status: "pending", records: [] as unknown[] },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.clearAllMocks();
});

describe("H/p campaign status contracts without research execution", () => {
  it.each([
    ["completed", "completed"],
    ["verification_incomplete", "pending"],
    ["solver_failure", "verification_incomplete"],
  ])("preserves D1 status for baseline %s", async (baselineStatus, expected) => {
    const current = report();
    const profiles = ["finite_low", "finite_mid", "finite_high", "censored_500", "censored_1000"];
    current.d1Robustness.records = ["baseline", "candidate"].flatMap((candidateId) =>
      profiles.map((profile) => ({
        candidateId,
        stratumKey: "stratum",
        profile,
        events: 1,
        evaluation: {
          status: candidateId === "baseline" ? baselineStatus : "completed",
          successProbability: 0.9,
          expectedConsumption: { blue: 10, purple: 0, yellow: 0 },
          exhaustionProbability: { blue: 0, purple: 0, yellow: 0 },
        },
      })),
    );
    mocks.readReport.mockResolvedValue(current);
    mocks.readFile.mockImplementation(async (url: URL) =>
      url.pathname.endsWith("min-ef-hp-d1-snapshot.json")
        ? JSON.stringify({ kind: "min-ef-hp-d1-snapshot", version: 1, rows: [] })
        : new Uint8Array(),
    );
    mocks.module.mockImplementation(async (path: string) => {
      if (path.endsWith("min-ef-hp-d1.ts")) {
        return {
          selectD1HpStrata: () => ({ rows: [{}], coverage: 1 }),
          d1StratumKey: () => "stratum",
          classifyD1ProfilePasses: () => "passed",
        };
      }
      if (path.endsWith("min-ef-hp-model.ts")) return { hpCandidateById: (id: string) => ({ id }) };
      return {};
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await import("./run-min-ef-hp-d1");
    expect(current.d1Robustness.status).toBe(expected);
    expect(mocks.writeReport).toHaveBeenCalledOnce();
  });

  it.each([
    ["discovery", false, "no_exact_challenger", 0],
    ["confirmation", false, "no_discovery_challenger", 0],
    ["discovery", true, null, 24],
    ["confirmation", true, null, 12],
  ] as const)(
    "preserves %s challenger selection: %s",
    async (phase, challenger, reason, records) => {
      mocks.phase = phase;
      const current = report();
      current.exact.finalistIds = challenger ? ["baseline", "candidate"] : [];
      mocks.readReport.mockResolvedValue(current);
      mocks.readFile.mockResolvedValue(new Uint8Array());
      mockWasmInstantiation();
      const collect = vi.fn(() => ({
        status: "completed",
        samples: [{ completed: true, consumption: { blue: 10, purple: 0, yellow: 0 } }],
        elapsedMs: 0,
        solveCalls: 0,
        cachedPolicies: 0,
      }));
      const modules: Record<string, unknown> = {
        "min-ef-hp-model.ts": { hpCandidateById: (id: string) => ({ id }) },
        "min-ef-hp-policy.ts": {
          createHpLadderSession: () => ({
            policySolver: () => {
              throw new Error("A research solve must not run in this test.");
            },
            release: vi.fn(),
          }),
        },
        "trajectory.ts": { collectInteractiveTrajectories: collect },
        "journey-panels.ts": { journeyPanelById: (id: string) => ({ id }) },
        "metrics.ts": { maxSupplyDebtDays: () => 1 },
        "significance-gate.ts": {
          JOURNEY_COMPLETION_THRESHOLD: 0.995,
          gatePairedSeeds: () => ({ status: "completed", basePool: [1], candPool: [1] }),
        },
        "min-ef-hp-tail.ts": { evaluateHpTailGate: () => ({ passed: true }) },
      };
      mocks.module.mockImplementation(
        async (path: string) => modules[path.split("/").at(-1) ?? ""],
      );
      vi.spyOn(console, "log").mockImplementation(() => {});
      await import("./run-min-ef-hp-tail");
      expect(current.tailRisk.records).toHaveLength(records);
      expect(collect).toHaveBeenCalledTimes(records);
      expect(current.tailRisk).toMatchObject({ protocol: { skippedReason: reason } });
    },
  );
});
