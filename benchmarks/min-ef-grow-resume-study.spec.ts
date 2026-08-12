import { describe, expect, it } from "vitest";

import {
  classifySolveStatus,
  latencyLimit,
  memoryGatePassed,
  percentile,
} from "./min-ef-grow-resume-study.ts";
import {
  MIN_EF_GROW_RESUME_HELD_OUT_SCENARIOS,
  MIN_EF_GROW_RESUME_SCENARIOS,
} from "./scenarios/min-ef-grow-resume.ts";

describe("min-E[f] grow-and-resume research contract", () => {
  it("keeps discovery, confirmation, validation, and held-out scenarios distinct", () => {
    expect(MIN_EF_GROW_RESUME_HELD_OUT_SCENARIOS).toHaveLength(24);
    expect(MIN_EF_GROW_RESUME_SCENARIOS).toHaveLength(218);
    expect(new Set(MIN_EF_GROW_RESUME_SCENARIOS.map((scenario) => scenario.id)).size).toBe(218);
    expect(new Set(MIN_EF_GROW_RESUME_SCENARIOS.map((scenario) => scenario.cohort))).toEqual(
      new Set(["discovery", "confirmation", "validation", "held-out"]),
    );
  });

  it("maps solver statuses without treating failures as completed", () => {
    expect([0, 1, 2, 99].map(classifySolveStatus)).toEqual([
      "completed",
      "budget_exceeded",
      "memo_full",
      "failure",
    ]);
  });

  it("applies the pre-registered memory and latency boundaries inclusively", () => {
    expect(memoryGatePassed(116 * 1024 * 1024, 100 * 1024 * 1024)).toBe(true);
    expect(memoryGatePassed(116 * 1024 * 1024 + 1, 100 * 1024 * 1024)).toBe(false);
    expect(latencyLimit(100, { relativeFactor: 1.15, absoluteMarginMs: 50 })).toBe(150);
    expect(latencyLimit(1_000, { relativeFactor: 1.15, absoluteMarginMs: 50 })).toBe(1_150);
  });

  it("uses the shared nearest-rank percentile contract", () => {
    expect(percentile([9, 1, 4, 2], 0.5)).toBe(2);
    expect(percentile([9, 1, 4, 2], 0.95)).toBe(9);
  });
});
