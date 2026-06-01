import { describe, expect, it } from "vitest";

import {
  availabilityCandidateId,
  BASELINE_AVAILABILITY_CANDIDATE,
  buildAvailabilityGridCandidates,
  journeyHorizonAnchor,
  solveAvailabilityCandidate,
} from "./models/availability-grid";

describe("availability slider candidate grid", () => {
  it("defines the baseline candidate as the current supply policy", () => {
    const candidates = buildAvailabilityGridCandidates();

    expect(candidates).toHaveLength(35);
    expect(candidates.find((candidate) => candidate.role === "baseline")).toEqual(
      BASELINE_AVAILABILITY_CANDIDATE,
    );
    expect(availabilityCandidateId(0.01, 0.5, 3)).toBe(BASELINE_AVAILABILITY_CANDIDATE.id);
  });

  it("keeps preservation probes separate from the default grid", () => {
    const candidates = buildAvailabilityGridCandidates({
      includePreservationProbes: true,
      includeSensitivityProbes: true,
    });

    expect(candidates).toHaveLength(140);
    expect(candidates.some((candidate) => candidate.role === "preservation-probe")).toBe(true);
    expect(candidates.some((candidate) => candidate.role === "sensitivity-probe")).toBe(true);
  });

  it("solves a candidate through research-only tolerance and cost parameters", () => {
    const result = solveAvailabilityCandidate(
      {
        start: { grade: "SR", level: 10, exp: 0 },
        stock: { blue: 120, purple: 80, yellow: 40 },
        strategy: "supply",
      },
      {
        id: "tau0-h0-pinf",
        tolerance: 0,
        horizonFactor: 0,
        horizonDays: 0,
        normPower: Number.POSITIVE_INFINITY,
        role: "preservation-probe",
      },
    );

    expect(result.possible).toBe(true);
    expect(result.stats?.probabilityTolerance).toBe(0);
    expect(result.stats?.gateAudit).toBeDefined();
  });

  it("uses parallel supply time for journey horizon anchors", () => {
    expect(
      journeyHorizonAnchor(
        { blue: 300, purple: 150, yellow: 100 },
        { blue: 0, purple: 0, yellow: 0 },
      ),
    ).toBeCloseTo(113.1953428201811, 10);
  });
});
