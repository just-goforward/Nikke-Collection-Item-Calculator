import { describe, expect, it } from "vitest";

import {
  createExactInteractiveReplanSession,
  evaluateExactInteractiveReplan,
} from "./evaluator/exact-replan";
import {
  BALANCED_SET,
  FIXED_SAFETY_GRID,
  REQUIRED_SENTINELS,
  SCARCITY_SET,
} from "./scenarios/fixed-grid";

describe("A interactive-replan baseline", () => {
  it("defines the fixed safety grid and required runtime sentinels", () => {
    expect(FIXED_SAFETY_GRID).toHaveLength(96);
    expect(BALANCED_SET).toHaveLength(24);
    expect(SCARCITY_SET).toHaveLength(72);
    expect(REQUIRED_SENTINELS.map((scenario) => scenario.id).sort()).toEqual(
      [
        "R0-balanced100",
        "R0-balanced300",
        "R14e900-yellow30",
        "SR0-balanced100",
        "SR0-balanced300",
      ].sort(),
    );
  });

  it("evaluates exact success branching and separates manual-entry metrics", () => {
    const scenario = FIXED_SAFETY_GRID.find((item) => item.id === "R14e900-yellow30");
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error("Expected the scarcity sentinel scenario.");

    const result = evaluateExactInteractiveReplan(scenario, { timeBudgetMs: 10_000 });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected completed exact evaluation.");

    expect(result.successProbability).toBeGreaterThan(0);
    expect(result.successProbability).toBeLessThanOrEqual(1);
    expect(result.interactiveF).toBeGreaterThan(0);
    expect(result.manualEntryProbability).toBeGreaterThan(0);
    expect(result.manualEntryProbability).toBeLessThanOrEqual(1);
    expect(result.expectedManualEntries).toBeGreaterThanOrEqual(result.manualEntryProbability);
    expect(result.gateEvidence.internalDecisionCount).toBeGreaterThan(0);
    expect(result.gateEvidence.internalViolationCount).toBe(0);
    expect(result.gateEvidence.boundaryViolationCount).toBe(0);
    // These deterministic values fix the weighted attempt branching contract; success attempts
    // must not be replaced with a uniform pick from the recommended run.
    expect(result.successProbability).toBeCloseTo(0.5894521493051443, 12);
    expect(result.expectedConsumption.blue).toBeCloseTo(98.30459302217626, 10);
    expect(result.expectedConsumption.purple).toBeCloseTo(89.20814221565486, 10);
    expect(result.expectedConsumption.yellow).toBeCloseTo(19.934149189621014, 10);
    expect(result.successAttemptSelectionProbability).toBeCloseTo(0.4808787327283736, 12);
    expect(result.interactiveF).toBeCloseTo(0.3279638107027003, 12);
  });

  it("returns explicit incomplete evidence when an evaluation has no budget", () => {
    const scenario = FIXED_SAFETY_GRID[0];
    if (!scenario) throw new Error("Expected at least one fixed safety scenario.");
    const result = evaluateExactInteractiveReplan(scenario, { timeBudgetMs: 0 });

    expect(result.status).toBe("verification_incomplete");
    if (result.status !== "verification_incomplete") {
      throw new Error("Expected a time budget failure.");
    }
    expect(result.reason).toBe("time_budget_exceeded");
    expect(result.solveCalls).toBe(0);
  });

  it("does not treat a high-cost solve that overruns its budget as verified", () => {
    const scenario = REQUIRED_SENTINELS.find((item) => item.id === "R0-balanced300");
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error("Expected the high-cost sentinel scenario.");

    const result = evaluateExactInteractiveReplan(scenario, { timeBudgetMs: 1 });
    expect(result.status).toBe("verification_incomplete");
    if (result.status !== "verification_incomplete") {
      throw new Error("Expected a high-cost time budget failure.");
    }
    expect(result.reason).toBe("time_budget_exceeded");
    expect(result.solveCalls).toBe(1);
  });

  it("resumes a serialized timed-out exact evaluation without changing its final evidence", () => {
    const scenario = FIXED_SAFETY_GRID.find((item) => item.id === "R14e900-yellow30");
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error("Expected the resumable sentinel scenario.");

    const session = createExactInteractiveReplanSession(scenario);
    const interrupted = session.advance(1);
    expect(interrupted.status).toBe("verification_incomplete");
    if (interrupted.status !== "verification_incomplete") {
      throw new Error("Expected the first exact evaluation slice to time out.");
    }
    expect(interrupted.solveCalls).toBeGreaterThan(0);

    const savedCheckpoint = JSON.parse(JSON.stringify(session.checkpoint()));
    const resumed = createExactInteractiveReplanSession(scenario, {}, savedCheckpoint).advance(
      10_000,
    );
    const direct = evaluateExactInteractiveReplan(scenario, { timeBudgetMs: 10_000 });
    expect(resumed.status).toBe("completed");
    expect(direct.status).toBe("completed");
    const { elapsedMs: resumedElapsedMs, ...resumedEvidence } = resumed;
    const { elapsedMs: directElapsedMs, ...directEvidence } = direct;
    expect(resumedElapsedMs).toBeGreaterThanOrEqual(0);
    expect(directElapsedMs).toBeGreaterThanOrEqual(0);
    expect(resumedEvidence).toEqual(directEvidence);
  });
});
