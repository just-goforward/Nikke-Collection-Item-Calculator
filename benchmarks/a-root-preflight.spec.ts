import { describe, expect, it } from "vitest";

import { solveWithResearchCostModel } from "../src/solver";
import { FIXED_SAFETY_GRID } from "./scenarios/fixed-grid";

describe("production root probability-gate preflight", () => {
  it("keeps every internal root MDP decision inside the current supply gate", () => {
    let decisionCount = 0;
    let violationCount = 0;
    let maxGap = 0;
    let maxGapScenario = "";

    for (const scenario of FIXED_SAFETY_GRID) {
      const result = solveWithResearchCostModel(
        { start: scenario.start, stock: scenario.stock, strategy: "supply" },
        { kind: "availability-pnorm" },
      );
      const audit = result.stats?.gateAudit;
      expect(audit, `Expected probability gate evidence for ${scenario.id}.`).toBeDefined();
      if (!audit) continue;
      decisionCount += audit.decisionCount;
      violationCount += audit.violationCount;
      if (audit.maxGap > maxGap) {
        maxGap = audit.maxGap;
        maxGapScenario = scenario.id;
      }
      expect(audit.maxGap, `Maximum gap originated at ${scenario.id}.`).toBeLessThanOrEqual(
        (result.stats?.probabilityTolerance ?? 0) + 1e-12,
      );
    }

    expect(decisionCount).toBeGreaterThan(0);
    expect(violationCount).toBe(0);
    expect(maxGap, `Maximum gap originated at ${maxGapScenario}.`).toBeLessThanOrEqual(1e-12);
  });
});
