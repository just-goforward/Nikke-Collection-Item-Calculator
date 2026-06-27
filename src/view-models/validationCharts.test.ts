import { describe, expect, it } from "vitest";
import type { StageReachPoint } from "../types";
import { makeStageReachChart, makeValidationCharts } from "./validationCharts";

function stageReach(points: Array<[StageReachPoint["grade"], number, number]>): StageReachPoint[] {
  return points.map(([grade, level, probability]) => ({
    grade,
    level,
    probability,
    reached: Math.round(probability * 12_000),
  }));
}

describe("makeValidationCharts", () => {
  it("builds a stage reach chart from Monte Carlo reach data", () => {
    const chart = makeStageReachChart({
      runs: 12_000,
      completed: 360,
      successProbability: 0.03,
      stageReach: stageReach([
        ["SR", 15, 0.03],
        ["SR", 14, 0.12],
        ["SR", 13, 0.37],
        ["SR", 12, 0.74],
        ["SR", 11, 0.99],
      ]),
    });

    expect(chart.runsLabel).toBe("검산 12,000명 기준");
    expect(chart.points.map((point) => point.label)).toEqual([
      "SR 11 이하",
      "SR 12",
      "SR 13",
      "SR 14",
      "SR 15",
    ]);
    expect(chart.points[0]?.aggregateBelow).toBe(true);
    expect(chart.points.at(-1)?.percentLabel).toBe("3.0%");
  });

  it("falls back to the SR15 success rate when reach data is unavailable", () => {
    const { stageReach: chart } = makeValidationCharts(
      {
        runs: 1000,
        completed: 90,
        successProbability: 0.09,
      },
      0.1,
    );

    expect(chart.points).toHaveLength(1);
    expect(chart.points[0]?.label).toBe("SR 15");
    expect(chart.points[0]?.reachedLabel).toBe("90명");
  });

  it("collapses repeated high-stage probabilities instead of forcing SR15 on the right edge", () => {
    const chart = makeStageReachChart({
      runs: 12_000,
      completed: 408,
      successProbability: 0.034,
      stageReach: stageReach([
        ["SR", 15, 0.0338],
        ["SR", 14, 0.0339],
        ["SR", 13, 0.0341],
        ["SR", 12, 0.0342],
        ["SR", 11, 0.039],
      ]),
    });

    expect(chart.points.map((point) => point.label)).toEqual(["SR 11", "SR 12 이상"]);
    expect(chart.points.at(-1)?.aggregateAbove).toBe(true);
  });
});
