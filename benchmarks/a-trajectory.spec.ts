import { describe, expect, it } from "vitest";

import { collectInteractiveTrajectories } from "./evaluator/trajectory";
import { cvarUpperTail, maxSupplyDebtDays, summarizeTrajectories, supplyDebtDays } from "./metrics";
import { FIXED_SAFETY_GRID } from "./scenarios/fixed-grid";

describe("A interactive trajectory baseline", () => {
  it("is deterministic for a fixed seed and produces tail metrics", () => {
    const scenario = FIXED_SAFETY_GRID.find((item) => item.id === "R14e900-yellow30");
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error("Expected trajectory scenario.");

    const options = { runs: 100, seed: 20260505, timeBudgetMs: 10_000 };
    const first = collectInteractiveTrajectories(scenario, options);
    const second = collectInteractiveTrajectories(scenario, options);

    expect(first.status).toBe("completed");
    const { elapsedMs: firstElapsedMs, ...firstDeterministicResult } = first;
    const { elapsedMs: secondElapsedMs, ...secondDeterministicResult } = second;
    expect(firstElapsedMs).toBeGreaterThanOrEqual(0);
    expect(secondElapsedMs).toBeGreaterThanOrEqual(0);
    expect(secondDeterministicResult).toEqual(firstDeterministicResult);
    if (first.status !== "completed") throw new Error("Expected trajectory result.");

    const summary = summarizeTrajectories(first.samples);
    expect(summary.runs).toBe(100);
    expect(summary.completionRate).toBeGreaterThanOrEqual(0);
    expect(summary.completionRate).toBeLessThanOrEqual(1);
    expect(summary.depletionProbability).toBeGreaterThanOrEqual(0);
    expect(summary.depletionProbability).toBeLessThanOrEqual(1);
    expect(summary.maxSupplyDebtDaysCvar90).toBeGreaterThanOrEqual(0);
    expect(summary.meanMaxSupplyDebtDays).toBeGreaterThanOrEqual(0);
    expect(summary.meanDeficitVolumeDays).toBeGreaterThanOrEqual(summary.meanMaxSupplyDebtDays);
    expect(summary.manualEntryExposureRate).toBeGreaterThan(0);
    expect(summary.expectedManualEntries).toBeGreaterThanOrEqual(summary.manualEntryExposureRate);
  });

  it("computes supply debt in 28-day piece units for journey-demand panels", () => {
    const debt = supplyDebtDays({ blue: 473.912, purple: 83.712, yellow: 24.736 });

    expect(debt.blue).toBeCloseTo(0, 12);
    expect(debt.yellow).toBeCloseTo(0, 12);
    expect(debt.purple).toBeCloseTo(14, 12);
    expect(maxSupplyDebtDays({ blue: 473.912, purple: 83.712, yellow: 24.736 })).toBeCloseTo(
      14,
      12,
    );
  });

  it("computes upper-tail CVaR deterministically", () => {
    expect(cvarUpperTail([0, 1, 2, 100], 0.75)).toBe(100);
    expect(cvarUpperTail([0, 1, 2, 100], 0.5)).toBe(51);
  });

  it("does not claim tail verification after an exhausted time budget", () => {
    const scenario = FIXED_SAFETY_GRID[0];
    if (!scenario) throw new Error("Expected at least one fixed safety scenario.");
    const result = collectInteractiveTrajectories(scenario, {
      runs: 10,
      timeBudgetMs: 0,
    });
    expect(result.status).toBe("verification_incomplete");
    if (result.status !== "verification_incomplete") {
      throw new Error("Expected trajectory time budget failure.");
    }
    expect(result.runsCompleted).toBe(0);
  });
});
