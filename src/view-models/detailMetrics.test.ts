import { describe, expect, it } from "vitest";
import { makeMetricsDetailView } from "./detailMetrics";

describe("makeMetricsDetailView", () => {
  it("formats expected consumption, remaining stock, and integer percentages", () => {
    const view = makeMetricsDetailView(
      {
        input: {
          strategy: "supply",
          stock: { blue: 100, purple: 50, yellow: 20 },
        },
        best: {
          firstAction: "blue",
          firstProbability: 0.35,
          successProbability: 1,
          vector: { blue: 30, purple: 0, yellow: 10 },
        },
        stats: {
          states: 1234,
          probabilityTolerance: 0.01,
          solverBackend: "rust-min-ef",
          strategy: "supply",
        },
      },
      { count: 3, greatSuccessProbability: 0.875 },
      "12,000",
    );

    expect(view.successProbability).toBe("100%");
    expect(view.greatSuccessProbability).toBe("87.5%");
    expect(view.stateCount).toBe("1,234");
    expect(view.expectedConsumption).toEqual([
      { kit: "blue", pieces: "약 30개", supplyDays: "1.8일치" },
      { kit: "purple", pieces: "약 0개", supplyDays: "0일치" },
      { kit: "yellow", pieces: "약 10개", supplyDays: "11일치" },
    ]);
    expect(view.expectedRemaining).toBe("파랑 70개 · 보라 50개 · 노랑 10개");
    expect(view.monteCarloRuns).toBe("12,000");
    expect(view.solverLabel).toBe("Rust min E[f]");
  });

  it("marks candidates outside the probability tolerance", () => {
    const view = makeMetricsDetailView(
      {
        input: {
          stock: { blue: 100, purple: 100, yellow: 100 },
        },
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
      "12,000",
    );

    expect(view.candidates[0]?.rankLabel).toBe("추천");
    expect(view.candidates[0]?.excludedReason).toBeNull();
    expect(view.candidates[1]?.rankLabel).toBe("후보 2");
    expect(view.candidates[1]?.excludedReason).toContain("허용 확률 차이 초과");
    expect(view.solverLabel).toBe("JS phase2");
  });
});
