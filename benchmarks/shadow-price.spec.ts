import { describe, expect, it } from "vitest";

import { solveWithResearchCostModel } from "../src/solver/solve";
import { evaluateExactInteractiveReplan } from "./evaluator/exact-replan";
import { shadowGradient, solveBoundedShadow, solveSingleUpdateShadow } from "./models/shadow-price";
import { FIXED_SAFETY_GRID } from "./scenarios/fixed-grid";

const KITS = ["blue", "purple", "yellow"] as const;

describe("shadow-price research models", () => {
  const input = {
    start: { grade: "R" as const, level: 14, exp: 900 },
    stock: { blue: 100, purple: 100, yellow: 30 },
    strategy: "supply" as const,
  };

  it("derives non-negative gradient prices from the baseline expected consumption", () => {
    const baseline = solveWithResearchCostModel(input, { kind: "availability-pnorm" });
    const prices = shadowGradient(baseline.best.vector, input.stock);
    expect(KITS.every((kit) => Number.isFinite(prices[kit]) && prices[kit] >= 0)).toBe(true);
    expect(prices.blue + prices.purple + prices.yellow).toBeGreaterThan(0);
  });

  it("uses a single gradient update for B while preserving the supply probability gate", () => {
    const candidate = solveSingleUpdateShadow(input);
    const diagnostics = candidate.stats?.researchShadow;
    const audit = candidate.stats?.gateAudit;
    expect(diagnostics).toMatchObject({
      variant: "single-update",
      iterations: 1,
      converged: null,
      fallback: null,
    });
    expect(audit.violationCount).toBe(0);
    const finalPrices = diagnostics.finalPrices;
    if (!finalPrices) throw new Error("Expected single-update final shadow prices.");
    const shadowCost = KITS.reduce(
      (sum, kit) => sum + finalPrices[kit] * candidate.best.vector[kit],
      0,
    );
    expect(candidate.best.resourceCost).toBeCloseTo(shadowCost, 10);
  });

  it("falls back to A when bounded C has no iteration budget", () => {
    const baseline = solveWithResearchCostModel(input, { kind: "availability-pnorm" });
    const candidate = solveBoundedShadow(input, { timeoutMs: 0 });
    expect(candidate.stats?.researchShadow).toMatchObject({
      variant: "bounded-fixed-point",
      iterations: 0,
      converged: false,
      fallback: "timeout",
    });
    expect(candidate.best).toEqual(baseline.best);
  });

  it("keeps a single-update candidate that improves the current root p-norm objective", () => {
    const scenario = FIXED_SAFETY_GRID.find((item) => item.id === "SR5-blue30");
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error("Expected the blue scarcity scenario.");
    const candidateInput = {
      start: scenario.start,
      stock: scenario.stock,
      strategy: "supply" as const,
    };
    const baseline = solveWithResearchCostModel(candidateInput, { kind: "availability-pnorm" });
    const candidate = solveSingleUpdateShadow(candidateInput);
    expect(candidate.stats?.researchShadow?.fallback).toBeNull();
    if (
      candidate.stats.researchShadow.candidateRootF === null ||
      candidate.stats.researchShadow.candidateRootF === undefined ||
      candidate.stats.researchShadow.baselineRootF === null ||
      candidate.stats.researchShadow.baselineRootF === undefined
    ) {
      throw new Error("Expected single-update root objective diagnostics.");
    }
    expect(candidate.stats.researchShadow.candidateRootF).toBeLessThanOrEqual(
      candidate.stats.researchShadow.baselineRootF,
    );
    expect(candidate.best).not.toEqual(baseline.best);
  });

  it("rejects a converged fixed-point candidate that worsens the root objective", () => {
    const scenario = FIXED_SAFETY_GRID.find((item) => item.id === "SR10-blue10");
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error("Expected the high-level blue scarcity scenario.");
    const candidateInput = {
      start: scenario.start,
      stock: scenario.stock,
      strategy: "supply" as const,
    };
    const baseline = solveWithResearchCostModel(candidateInput, { kind: "availability-pnorm" });
    const candidate = solveBoundedShadow(candidateInput);
    expect(candidate.stats?.researchShadow).toMatchObject({
      converged: true,
      fallback: "root_objective_worsened",
    });
    if (
      candidate.stats.researchShadow.candidateRootF === null ||
      candidate.stats.researchShadow.candidateRootF === undefined ||
      candidate.stats.researchShadow.baselineRootF === null ||
      candidate.stats.researchShadow.baselineRootF === undefined
    ) {
      throw new Error("Expected fixed-point root objective diagnostics.");
    }
    expect(candidate.stats.researchShadow.candidateRootF).toBeGreaterThan(
      candidate.stats.researchShadow.baselineRootF,
    );
    expect(candidate.best).toEqual(baseline.best);
  });

  it("can evaluate B on the exact interactive-replan path without gate violations", () => {
    const scenario = FIXED_SAFETY_GRID.find((item) => item.id === "R14e900-yellow30");
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error("Expected the low-cost scarcity scenario.");

    const result = evaluateExactInteractiveReplan(scenario, {
      modelId: "B",
      policySolver: solveSingleUpdateShadow,
      timeBudgetMs: 10_000,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected completed B evaluation.");
    expect(result.gateEvidence.internalViolationCount).toBe(0);
    expect(result.gateEvidence.boundaryViolationCount).toBe(0);
  });
});
