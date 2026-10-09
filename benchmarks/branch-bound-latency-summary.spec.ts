import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  spawnSync: vi.fn(() => {
    throw new Error("Research children must not execute.");
  }),
}));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile, writeFile: mocks.writeFile }));
vi.mock("./research-provenance.ts", () => ({
  collectResearchProvenance: () => ({ sourceFingerprint: "fixture" }),
  assertResearchReportCanBeWritten: vi.fn(),
  fingerprintResearchArtifact: () => ({ sha256: "fixture" }),
  sameResearchIdentity: () => true,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.clearAllMocks();
});

describe("B2 latency checkpoint summary without research execution", () => {
  it.each([false, true])(
    "preserves parity and nearest-rank gates: mismatch %s",
    async (mismatch) => {
      const scenarioIds = ["semantic-dominance-cap-tier21", "R0-balanced250-tier22"];
      const samples = Array.from({ length: 31 }, (_, repeat) =>
        ["product", "candidate"].flatMap((build) =>
          scenarioIds.map((scenarioId) => ({
            repeat,
            build,
            scenarioId,
            elapsedMs: build === "product" ? 10 : 12,
            memoryGrowthBytes: 0,
            nodeCount: 1,
            semantic: { action: mismatch && build === "candidate" ? 1 : 0 },
          })),
        ),
      ).flat();
      mocks.readFile.mockImplementation(async (url: URL) => {
        if (url.pathname.endsWith(".checkpoint.json"))
          return JSON.stringify({ samples, provenance: {} });
        throw Object.assign(new Error("No existing report"), { code: "ENOENT" });
      });
      vi.spyOn(console, "log").mockImplementation(() => {});
      await import("./run-min-ef-branch-bound-b2-latency");
      expect(mocks.spawnSync).not.toHaveBeenCalled();
      expect(mocks.writeFile).toHaveBeenCalledOnce();
      const report = JSON.parse(mocks.writeFile.mock.calls[0]?.[1] as string);
      expect(report.samples).toEqual(samples);
      expect(report.gate).toEqual({
        passed: !mismatch,
        blockers: mismatch ? scenarioIds.map((id) => `${id}: semantic snapshot mismatch`) : [],
      });
      for (const id of scenarioIds) {
        expect(report.scenarios[id]).toMatchObject({
          product: { count: 31, p50Ms: 10, p95Ms: 10, nodeCounts: [1], memoryGrowthMaxBytes: 0 },
          candidate: { count: 31, p50Ms: 12, p95Ms: 12 },
          semanticParity: !mismatch,
          p95LimitMs: 60,
          passed: !mismatch,
        });
      }
    },
  );
});
