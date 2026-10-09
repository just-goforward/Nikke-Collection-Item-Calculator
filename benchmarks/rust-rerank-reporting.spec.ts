import { afterEach, describe, expect, it, vi } from "vitest";
import type { RustPhase2ResearchSolver } from "../src/wasm/rustTypes";
import {
  parseRustBenchmarkWeightSpec,
  rustBenchmarkWeightForScenario,
} from "./rust-benchmark-weights";
import { compareA1ForActions, compareA2ForActions } from "./rust-rerank-benchmark-actions";

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("node:fs/promises", () => mocks);

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  mocks.readFile.mockReset();
  mocks.writeFile.mockReset();
});

describe("research weighting contracts", () => {
  it.each([
    ["product-observed", 1.6, 1.2],
    ["product-observed-high-stock", 0.35, 0.6],
    ["fixed-grid", 0.85, 1],
    ["gain28-supplemental", 0.3, 0.7],
  ] as const)("preserves both source profiles for %s", (source, usage, risk) => {
    const scenario = {
      id: "fixture",
      group: "scarcity",
      source,
      start: { grade: "SR" as const, level: 14, exp: 0 },
    };
    expect(
      rustBenchmarkWeightForScenario(
        scenario,
        parseRustBenchmarkWeightSpec(undefined, "usage-proxy-v1"),
      ),
    ).toBe(usage * 0.85 * 1.1);
    expect(
      rustBenchmarkWeightForScenario(
        scenario,
        parseRustBenchmarkWeightSpec(undefined, "risk-proxy-v1"),
      ),
    ).toBe(risk * 1.6 * 1.2);
  });
});

describe.each([
  ["exact", compareA1ForActions],
  ["surrogate", compareA2ForActions],
] as const)("%s comparison failures", (_name, compare) => {
  it.each([
    [undefined, null],
    [null, "null"],
    [0, "0"],
    ["failed", "failed"],
    [new Error("failed"), "failed"],
  ] as const)("preserves nullable errors for %s", (error, message) => {
    const fail = vi.fn(() => {
      throw error;
    });
    const unexpected = () => {
      throw new Error("Unexpected research solver call.");
    };
    const solver: RustPhase2ResearchSolver = {
      setSupplyForecast: unexpected,
      configureMemoTier: unexpected,
      configureSegmentedOverflow: unexpected,
      memoTier: unexpected,
      memoCapacity: unexpected,
      memoLogicalBytes: unexpected,
      overflowSegments: unexpected,
      releaseMemo: unexpected,
      buildPolicy: unexpected,
      solveRoot: unexpected,
      rootCandidates: unexpected,
      simulatePolicy: unexpected,
      simulatePolicyAfterFirstAction: unexpected,
      estimateExpectedCostAfterFirstAction: unexpected,
      estimateExpectedCostAfterFirstActionFromCurrent: unexpected,
      estimateExpectedCostAfterFirstActionFromCurrentWithMoments: unexpected,
      estimateExpectedCostPairFromCurrent: unexpected,
      estimateExactExpectedCostAfterFirstActionFromCurrent: fail,
      estimateA2SurrogateAfterFirstActionFromCurrent: fail,
      selectFirstActionByExpectedCost: unexpected,
      selectFirstActionByExactExpectedCost: unexpected,
    };
    const result = compare({
      solver,
      scenario: {
        id: "fixture",
        group: "balanced",
        source: "fixed-grid",
        start: { grade: "SR", level: 14, exp: 0 },
        stock: { blue: 10, purple: 10, yellow: 10 },
      },
      baselineFirstAction: "blue",
      selectedFirstAction: "purple",
      enabled: true,
    });
    expect(result).toEqual({
      baselineCost: null,
      selectedCost: null,
      deltaVsBaseline: null,
      nodeCount: null,
      errorMessage: message,
    });
    expect(fail).toHaveBeenCalledOnce();
  });
});

describe("research direction verdict output", () => {
  it.each([
    [-1, 0, 40, "staging_candidate_with_low_observed_added_latency"],
    [-1, 1, 40, "paired95_quality_ok_but_product_adaptive_or_latency_needs_work"],
    [null, null, 50, "paired95_quality_ok_but_product_adaptive_or_latency_needs_work"],
    [null, null, null, "keep_staging_until_quality_or_latency_is_clear"],
  ] as const)(
    "preserves verdict precedence for %s/%s/%s",
    async (delta, falsePositive, latency, expected) => {
      const paired95 = { weightedSumDelta: delta, falsePositiveCount: falsePositive };
      if (latency !== null) {
        paired95.weightedSumDelta = -1;
        paired95.falsePositiveCount = 0;
      }
      mocks.readFile.mockImplementation(async (url: URL) =>
        JSON.stringify(
          url.pathname.endsWith("rust-runtime-benchmark.json")
            ? {
                backendComparisons: {
                  "rust-phase2_vs_js-phase2": { weightedMeanDeltaMs: -1 },
                  "rust-phase2-rerank_vs_rust-phase2": { weightedMeanDeltaMs: latency },
                },
              }
            : {
                policySummaries: {
                  adaptive90: { weightedSumDelta: delta, falsePositiveCount: falsePositive },
                  paired95,
                },
              },
        ),
      );
      mocks.writeFile.mockResolvedValue(undefined);
      vi.spyOn(console, "log").mockImplementation(() => {});
      await import("./analyze-rust-solver-direction");
      expect(mocks.writeFile).toHaveBeenCalledOnce();
      const output: unknown = JSON.parse(String(mocks.writeFile.mock.calls[0]?.[1]));
      expect(output).toMatchObject({
        verdict: {
          rustPhase2: "strong_candidate_for_default_backend",
          rustPhase2Rerank: expected,
          a2: "missing_surrogate_evidence",
        },
      });
    },
  );
});
