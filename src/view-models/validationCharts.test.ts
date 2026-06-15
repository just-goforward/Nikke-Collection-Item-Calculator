import { describe, expect, it } from "vitest";
import { makeValidationCharts } from "./validationCharts";

describe("makeValidationCharts", () => {
  it("marks certain outcomes as deterministic", () => {
    const { successDistribution } = makeValidationCharts(
      {
        runs: 1000,
        completed: 1000,
        successProbability: 1,
      },
      1,
    );

    expect(successDistribution.kind).toBe("deterministic");
    expect(successDistribution.points).toEqual([]);
    expect(successDistribution.intervalLabel).toBe("결과 폭 없음");
    expect(successDistribution.expectedRateLabel).toBe("100%");
  });

  it("builds a low-probability binomial distribution around the expected count", () => {
    const { successDistribution } = makeValidationCharts(
      {
        runs: 12_000,
        completed: 364,
        successProbability: 364 / 12_000,
      },
      0.031402,
    );

    expect(successDistribution.kind).toBe("binomial");
    expect(successDistribution.points.length).toBeGreaterThan(10);
    expect(successDistribution.xMin).toBeLessThanOrEqual(successDistribution.observedCount);
    expect(successDistribution.xMax).toBeGreaterThanOrEqual(successDistribution.observedCount);
    expect(successDistribution.skewnessLabel).toMatch(/^왜도 0\./);
    expect(successDistribution.kurtosisLabel).toMatch(/^초과첨도 0\./);
  });

  it("keeps an outlier observation visible in the chart domain", () => {
    const { successDistribution } = makeValidationCharts(
      {
        runs: 1000,
        completed: 900,
        successProbability: 0.9,
      },
      0.5,
    );

    expect(successDistribution.xMin).toBeLessThan(successDistribution.meanCount);
    expect(successDistribution.xMax).toBeGreaterThanOrEqual(900);
    expect(successDistribution.observedCountLabel).toBe("이번 900명");
  });
});
