import { describe, expect, it } from "vitest";

import { screenAvailabilityCandidate } from "./evaluator/availability-screen";
import { BASELINE_AVAILABILITY_CANDIDATE } from "./models/availability-grid";
import { FIXED_SAFETY_GRID } from "./scenarios/fixed-grid";

describe("availability slider screen", () => {
  it("screens root-level structural signals without rejecting viable baseline candidates", () => {
    const scenario = FIXED_SAFETY_GRID.find((item) => item.id === "SR10-balanced100");
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error("Expected a screen scenario.");

    const result = screenAvailabilityCandidate(scenario, BASELINE_AVAILABILITY_CANDIDATE);

    expect(result.status).toBe("screened");
    expect(result.baseline.possible).toBe(true);
    expect(result.candidate.possible).toBe(true);
    expect(result.firstActionChanged).toBe(false);
    expect(result.runCountChanged).toBe(false);
    expect(result.promoteScore).toBeGreaterThanOrEqual(0);
  });

  it("promotes structurally different candidates instead of treating them as failures", () => {
    const scenario = FIXED_SAFETY_GRID.find((item) => item.id === "SR10-yellow30");
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error("Expected a scarcity screen scenario.");

    const result = screenAvailabilityCandidate(scenario, {
      id: "tau0-h0-pinf",
      tolerance: 0,
      horizonFactor: 0,
      horizonDays: 0,
      normPower: Number.POSITIVE_INFINITY,
      role: "preservation-probe",
    });

    expect(["screened", "hard-infeasible"]).toContain(result.status);
    expect(result.errorMessage).toBeUndefined();
    expect(result.promoteScore).toBeGreaterThanOrEqual(0);
  });
});
