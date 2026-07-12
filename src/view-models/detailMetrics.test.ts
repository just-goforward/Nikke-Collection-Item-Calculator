import { describe, expect, it } from "vitest";
import { makeMetricsDetailView } from "./detailMetrics";

describe("makeMetricsDetailView", () => {
  it("formats result metrics and integer percentages", () => {
    const view = makeMetricsDetailView(
      {
        input: {
          strategy: "supply",
        },
        best: {
          firstAction: "blue",
          firstProbability: 0.35,
          successProbability: 1,
          vector: { blue: 30, purple: 0, yellow: 10 },
        },
        stats: {
          probabilityTolerance: 0.01,
          solverBackend: "rust-min-ef",
          strategy: "supply",
        },
      },
      { count: 3, greatSuccessProbability: 0.875 },
      12_000,
    );

    expect(view.successProbability).toBe("100%");
    expect(view.greatSuccessProbability).toBe("87.5%");
    expect(view.monteCarloRuns).toBe(12_000);
    expect(view.solverLabel).toBe("Rust min E[f]");
  });

  it("marks candidates outside the probability tolerance", () => {
    const view = makeMetricsDetailView(
      {
        input: {},
        best: {
          firstAction: "blue",
          firstProbability: 0.25,
          successProbability: 0.99,
          vector: { blue: 10 },
        },
        topCandidates: [
          {
            firstAction: "blue",
            firstProbability: 0.25,
            successProbability: 0.99,
            probabilityGap: 0,
            vector: { blue: 10 },
          },
          {
            firstAction: "yellow",
            firstProbability: 0.2,
            successProbability: 0.9,
            probabilityGap: 0.05,
            vector: { yellow: 20 },
          },
        ],
        stats: {
          probabilityTolerance: 0.01,
        },
      },
      { count: 1, greatSuccessProbability: 0.25 },
      12_000,
    );

    expect(view.candidates[0]?.rankLabel.key).toBe("common.recommended");
    expect(view.candidates[0]?.excludedReason).toBeNull();
    expect(view.candidates[0]?.successProbabilityDetailed).toBe("99%");
    expect(view.candidates[1]?.rankLabel).toEqual({
      key: "detail.rankCandidate",
      params: { rank: 2 },
    });
    expect(view.candidates[1]?.excludedReason?.key).toBe("detail.reasonLowerReach");
    expect(view.candidates[1]?.excludedReasonHelp?.key).toBe("detail.reasonLowerReachHelp");
    expect(view.solverLabel).toBe("JS phase2");
  });

  it("uses a compact micro-lag reason when rounded candidate probabilities match", () => {
    const view = makeMetricsDetailView(
      {
        input: {},
        best: {
          firstAction: "purple",
          firstProbability: 0.25,
          successProbability: 0.990104,
          vector: { purple: 20 },
        },
        topCandidates: [
          {
            firstAction: "purple",
            firstProbability: 0.25,
            successProbability: 0.990104,
            probabilityGap: 0,
            vector: { purple: 20 },
          },
          {
            firstAction: "blue",
            firstProbability: 0.2,
            successProbability: 0.990061,
            probabilityGap: 0.000043,
            vector: { blue: 50 },
          },
        ],
        stats: {
          probabilityTolerance: 0,
        },
      },
      { count: 2, greatSuccessProbability: 0.25 },
      12_000,
    );

    expect(view.candidates[0]?.successProbability).toBe("99.01%");
    expect(view.candidates[0]?.successProbabilityMedium).toBe("99.010%");
    expect(view.candidates[0]?.successProbabilityDetailed).toBe("99.0104%");
    expect(view.candidates[1]?.successProbability).toBe("99.01%");
    expect(view.candidates[1]?.successProbabilityMedium).toBe("99.006%");
    expect(view.candidates[1]?.successProbabilityDetailed).toBe("99.0061%");
    expect(view.candidates[1]?.excludedReason?.key).toBe("detail.reasonSlightlyLower");
    expect(view.candidates[1]?.excludedReasonHelp?.key).toBe("detail.reasonSlightlyLowerHelp");
  });
});

describe("candidate exclusion reasons", () => {
  it("marks equally successful alternatives as excluded by higher kit burden", () => {
    const view = makeMetricsDetailView(
      {
        input: {},
        best: {
          firstAction: "purple",
          firstProbability: 0.25,
          successProbability: 1,
          vector: { purple: 20 },
        },
        topCandidates: [
          {
            firstAction: "purple",
            firstProbability: 0.25,
            successProbability: 1,
            probabilityGap: 0,
            resourceCost: 0.12,
            vector: { purple: 20 },
          },
          {
            firstAction: "blue",
            firstProbability: 0.2,
            successProbability: 1,
            probabilityGap: 0,
            resourceCost: 0.15,
            vector: { blue: 30 },
          },
          {
            firstAction: "yellow",
            firstProbability: 0.2,
            successProbability: 1,
            probabilityGap: 0,
            resourceCost: 0.2,
            vector: { yellow: 10 },
          },
        ],
        stats: {
          probabilityTolerance: 0.01,
        },
      },
      { count: 2, greatSuccessProbability: 0.25 },
      12_000,
    );

    expect(view.candidates.map((candidate) => candidate.successProbability)).toEqual([
      "100%",
      "100%",
      "100%",
    ]);
    expect(view.candidates[0]?.rankLabel.key).toBe("common.recommended");
    expect(view.candidates[0]?.excludedReason).toBeNull();
    expect(view.candidates[1]?.excludedReason?.key).toBe("detail.reasonHigherBurden");
    expect(view.candidates[1]?.excludedReasonHelp?.key).toBe("detail.reasonHigherBurdenHelp");
    expect(view.candidates[2]?.excludedReason?.key).toBe("detail.reasonHigherBurden");
  });

  it("keeps the actual recommended action first before assigning exclusion reasons", () => {
    const view = makeMetricsDetailView(
      {
        input: {},
        best: {
          firstAction: "yellow",
          firstProbability: 0.25,
          successProbability: 1,
          vector: { yellow: 10 },
        },
        topCandidates: [
          {
            firstAction: "blue",
            firstProbability: 0.2,
            successProbability: 1,
            probabilityGap: 0,
            resourceCost: 0.2,
            vector: { blue: 20 },
          },
          {
            firstAction: "yellow",
            firstProbability: 0.25,
            successProbability: 1,
            probabilityGap: 0,
            resourceCost: 0.1,
            vector: { yellow: 10 },
          },
        ],
        stats: {
          probabilityTolerance: 0.01,
        },
      },
      { count: 1, greatSuccessProbability: 0.25 },
      12_000,
    );

    expect(view.candidates[0]).toMatchObject({
      excludedReason: null,
      kit: "yellow",
      rankLabel: { key: "common.recommended" },
    });
    expect(view.candidates[1]).toMatchObject({
      excludedReason: { key: "detail.reasonHigherBurden" },
      kit: "blue",
    });
  });
});
