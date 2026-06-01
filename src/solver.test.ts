import { describe, expect, it } from "vitest";

import {
  convertState,
  EXPECTED_28_DAY_GAIN,
  normalizeState,
  SUPPLY_AVAILABILITY_PARAMS,
  solve,
  solveWithResearchCostModel,
  transition,
} from "./solver";

const KITS = ["blue", "purple", "yellow"] as const;
type CandidateResult = {
  run?: { count: number };
  successProbability: number;
  resourceCost: number;
};

function expectedAvailabilityCost(
  vector: Record<(typeof KITS)[number], number>,
  stock: Record<(typeof KITS)[number], number>,
  options: { horizonFactor?: number; normPower?: number } = {},
) {
  const horizonFactor = options.horizonFactor ?? SUPPLY_AVAILABILITY_PARAMS.horizon;
  const normPower = options.normPower ?? SUPPLY_AVAILABILITY_PARAMS.normPower;
  const ratios = KITS.map((kit) => {
    const availability = stock[kit] + horizonFactor * EXPECTED_28_DAY_GAIN[kit];
    if (availability <= 0) return vector[kit] > 1e-12 ? Number.POSITIVE_INFINITY : 0;
    return vector[kit] / availability;
  });
  if (normPower === Number.POSITIVE_INFINITY) return Math.max(...ratios);
  const powered = ratios.reduce((sum, ratio) => sum + ratio ** normPower, 0);
  return powered ** (1 / normPower);
}

describe("solver transitions", () => {
  it("keeps level 0 as a valid starting state", () => {
    expect(normalizeState({ grade: "R", level: 0, exp: 0 })).toEqual({
      grade: "R",
      level: 0,
      exp: 0,
    });

    const result = solve(
      {
        stock: { blue: 100, purple: 0, yellow: 0 },
      },
      undefined,
    );
    expect(result.input?.start).toEqual({ grade: "R", level: 0, exp: 0 });
  });

  it("normalizes max level states without carrying extra exp", () => {
    expect(normalizeState({ grade: "R", level: 15, exp: 900 })).toEqual({
      grade: "R",
      level: 15,
      exp: 0,
    });
    expect(normalizeState({ grade: "SR", level: 99, exp: 2900 })).toEqual({
      grade: "SR",
      level: 15,
      exp: 0,
    });
  });

  it("converts R15 into SR5", () => {
    expect(convertState()).toEqual({ grade: "SR", level: 5, exp: 0 });
    const result = solve(
      {
        start: { grade: "R", level: 15, exp: 0 },
        stock: { blue: 0, purple: 0, yellow: 0 },
      },
      undefined,
    );
    expect(result.convertOnly).toBe(true);
    const best = result.best;
    expect(best).toBeDefined();
    if (!best) throw new Error("Expected conversion best action.");
    expect(best.firstAction).toBe("convert");
    expect(best.successProbability).toBe(1);
  });

  it("applies SR 10 purple transition probability and fail exp", () => {
    const result = transition({ grade: "SR", level: 10, exp: 0 }, "purple");
    expect(result.probability).toBeCloseTo(0.054, 6);
    expect(result.success).toEqual({ grade: "SR", level: 15, exp: 0 });
    expect(result.fail).toEqual({ grade: "SR", level: 10, exp: 500 });
  });

  it("applies level 0 great-success rates and transitions", () => {
    const rBlue = transition({ grade: "R", level: 0, exp: 0 }, "blue");
    expect(rBlue.probability).toBeCloseTo(0.176, 6);
    expect(rBlue.success).toEqual({ grade: "R", level: 5, exp: 0 });
    expect(rBlue.fail).toEqual({ grade: "R", level: 0, exp: 200 });

    const srYellow = transition({ grade: "SR", level: 0, exp: 0 }, "yellow");
    expect(srYellow.probability).toBeCloseTo(0.25, 6);
    expect(srYellow.success).toEqual({ grade: "SR", level: 5, exp: 0 });
    expect(srYellow.fail).toEqual({ grade: "SR", level: 0, exp: 1000 });
  });

  it("levels up from 0 to 1 through failed kit experience", () => {
    const result = transition({ grade: "R", level: 0, exp: 800 }, "blue");
    expect(result.fail).toEqual({ grade: "R", level: 1, exp: 0 });
  });
});

describe("solver policy", () => {
  it("returns a possible exact MDP result for a representative inventory", () => {
    const result = solve(
      {
        start: { grade: "SR", level: 10, exp: 0 },
        stock: { blue: 0, purple: 0, yellow: 100 },
        strategy: "single",
      },
      undefined,
    );
    expect(result.possible).toBe(true);
    const best = result.best;
    const stats = result.stats;
    const topCandidates = result.topCandidates;
    expect(best).toBeDefined();
    expect(stats).toBeDefined();
    expect(topCandidates).toBeDefined();
    if (!best || !stats || !topCandidates) throw new Error("Expected possible MDP result.");
    expect(best.firstAction).toMatch(/blue|purple|yellow/);
    expect(stats.exact).toBe(true);
    expect(topCandidates.length).toBeGreaterThan(0);
    expect(
      topCandidates.every(
        (candidate: CandidateResult) => candidate.run && candidate.run.count >= 1,
      ),
    ).toBe(true);
  });

  it("keeps Monte Carlo validation deterministic for the same seed", () => {
    const input = {
      start: { grade: "SR" as const, level: 10, exp: 0 },
      stock: { blue: 80, purple: 60, yellow: 20 },
      strategy: "supply" as const,
      monteCarloRuns: 500,
      monteCarloSeed: 12345,
    };
    const first = solve(input, undefined).monteCarlo;
    const second = solve(input, undefined).monteCarlo;
    expect(second).toEqual(first);
    expect(first).toBeDefined();
    if (!first) throw new Error("Expected Monte Carlo result.");
    expect(first.runs).toBe(500);
  });

  it("uses availability p-norm as supply resource cost", () => {
    const stock = { blue: 80, purple: 60, yellow: 20 };
    const result = solve(
      {
        start: { grade: "SR", level: 10, exp: 0 },
        stock,
        strategy: "supply",
      },
      undefined,
    );
    const best = result.best;
    const stats = result.stats;
    expect(best).toBeDefined();
    expect(stats?.supplyAvailability).toEqual(SUPPLY_AVAILABILITY_PARAMS);
    if (!best) throw new Error("Expected supply best action.");

    const expected = expectedAvailabilityCost(best.vector, stock);
    expect(best.supplyCost).toBeCloseTo(expected, 10);
    expect(best.availabilityCost).toBeCloseTo(expected, 10);
    expect(best.resourceCost).toBeCloseTo(expected, 10);
    expect(best.legacySupplyCost).not.toBeCloseTo(expected, 6);
  });

  it("counts sub-10 stock pieces in supply availability", () => {
    const stock = { blue: 0, purple: 0, yellow: 19 };
    const result = solve(
      {
        start: { grade: "SR", level: 10, exp: 0 },
        stock,
        strategy: "supply",
      },
      undefined,
    );
    const best = result.best;
    expect(best).toBeDefined();
    if (!best) throw new Error("Expected one yellow use to be available.");
    expect(best.vector.yellow).toBeGreaterThan(0);

    const expectedWithPieces = expectedAvailabilityCost(best.vector, stock);
    const expectedWithFlooredUses = expectedAvailabilityCost(best.vector, {
      blue: 0,
      purple: 0,
      yellow: 10,
    });
    expect(best.resourceCost).toBeCloseTo(expectedWithPieces, 10);
    expect(Math.abs(best.resourceCost - expectedWithFlooredUses)).toBeGreaterThan(0.01);
  });

  it("orders research supply candidates by resource cost after an explicit probability gate", () => {
    const result = solveWithResearchCostModel(
      {
        start: { grade: "SR", level: 10, exp: 0 },
        stock: { blue: 120, purple: 80, yellow: 40 },
        strategy: "supply",
      },
      { kind: "availability-pnorm", horizonFactor: 0.5, normPower: 3 },
      undefined,
      { toleranceOverride: 0.01 },
    );
    const topCandidates = result.topCandidates;
    const stats = result.stats;
    expect(topCandidates).toBeDefined();
    if (!topCandidates) throw new Error("Expected supply top candidates.");
    expect(topCandidates.length).toBeGreaterThan(1);
    const maxSuccessProbability = Number(stats?.maxSuccessProbability || 0);
    const tolerance = Number(stats?.probabilityTolerance || 0);
    const eligible = topCandidates.filter(
      (candidate: CandidateResult) =>
        maxSuccessProbability - Number(candidate.successProbability) <= tolerance + 1e-12,
    );
    expect(eligible.length).toBeGreaterThan(1);

    for (let index = 1; index < eligible.length; index += 1) {
      const previous = eligible[index - 1];
      const current = eligible[index];
      expect(Number(previous.resourceCost)).toBeLessThanOrEqual(
        Number(current.resourceCost) + 1e-8,
      );
    }
  });

  it("keeps the default research cost model identical to the product solver", () => {
    const input = {
      start: { grade: "R" as const, level: 10, exp: 0 },
      stock: { blue: 100, purple: 30, yellow: 100 },
      strategy: "supply" as const,
    };
    const productResult = solve(input, undefined);
    const researchResult = solveWithResearchCostModel(input, { kind: "availability-pnorm" });
    const { gateAudit, ...researchStats } = researchResult.stats;

    expect(gateAudit).toBeDefined();
    expect({ ...researchResult, stats: researchStats }).toEqual(productResult);
  });

  it("collects bounded probability gate evidence for research solves", () => {
    const result = solveWithResearchCostModel(
      {
        start: { grade: "R", level: 0, exp: 0 },
        stock: { blue: 100, purple: 100, yellow: 100 },
        strategy: "supply",
      },
      { kind: "availability-pnorm" },
    );
    const gateAudit = result.stats?.gateAudit;
    expect(gateAudit).toBeDefined();
    if (!gateAudit || !result.stats) throw new Error("Expected research probability gate audit.");
    expect(gateAudit.decisionCount).toBe(result.stats.states);
    expect(gateAudit.maxGap).toBeLessThanOrEqual(result.stats.probabilityTolerance + 1e-12);
    expect(gateAudit.violationCount).toBe(0);
    expect(gateAudit.eligibleEmptyCount).toBeGreaterThanOrEqual(0);
    expect(gateAudit.fixedToleranceViolationCount).toBe(0);
    expect(gateAudit.firstViolationWitness).toBeNull();
    expect(gateAudit.firstFixedToleranceViolationWitness).toBeNull();
  });

  it("supports research-only horizon and minimax availability parameters", () => {
    const stock = { blue: 120, purple: 80, yellow: 40 };
    const result = solveWithResearchCostModel(
      {
        start: { grade: "SR", level: 10, exp: 0 },
        stock,
        strategy: "supply",
      },
      { kind: "availability-pnorm", horizonFactor: 1, normPower: Number.POSITIVE_INFINITY },
    );
    const best = result.best;
    expect(best).toBeDefined();
    if (!best) throw new Error("Expected a minimax research recommendation.");

    expect(best.resourceCost).toBeCloseTo(
      expectedAvailabilityCost(best.vector, stock, {
        horizonFactor: 1,
        normPower: Number.POSITIVE_INFINITY,
      }),
      10,
    );
    expect(best.availabilityCost).toBeCloseTo(expectedAvailabilityCost(best.vector, stock), 10);
  });

  it("keeps zero-horizon zero-consumption ratios finite for research probes", () => {
    const result = solveWithResearchCostModel(
      {
        start: { grade: "SR", level: 10, exp: 0 },
        stock: { blue: 0, purple: 0, yellow: 30 },
        strategy: "supply",
      },
      { kind: "availability-pnorm", horizonFactor: 0, normPower: 3 },
    );
    const best = result.best;
    expect(best).toBeDefined();
    if (!best) throw new Error("Expected a zero-horizon research recommendation.");
    expect(best.firstAction).toBe("yellow");
    expect(Number.isFinite(best.resourceCost)).toBe(true);
  });

  it("applies tolerance overrides only through the research solve path", () => {
    const input = {
      start: { grade: "R" as const, level: 0, exp: 0 },
      stock: { blue: 100, purple: 100, yellow: 100 },
      strategy: "supply" as const,
    };
    const productResult = solve(input, undefined);
    const researchResult = solveWithResearchCostModel(
      input,
      { kind: "availability-pnorm" },
      undefined,
      { toleranceOverride: 0 },
    );

    expect(productResult.stats?.probabilityTolerance).toBe(0.01);
    expect(researchResult.stats?.probabilityTolerance).toBe(0);
    expect(researchResult.stats?.gateAudit).toBeDefined();
  });

  it("uses linear shadow prices only as the research selection cost", () => {
    const stock = { blue: 120, purple: 80, yellow: 40 };
    const prices = { blue: 0.02, purple: 0.05, yellow: 0.1 };
    const result = solveWithResearchCostModel(
      {
        start: { grade: "SR", level: 10, exp: 0 },
        stock,
        strategy: "supply",
      },
      { kind: "linear-shadow", prices },
    );
    const best = result.best;
    expect(best).toBeDefined();
    if (!best) throw new Error("Expected a linear shadow recommendation.");

    const shadowCost = KITS.reduce((sum, kit) => sum + best.vector[kit] * prices[kit], 0);
    expect(best.resourceCost).toBeCloseTo(shadowCost, 10);
    expect(best.availabilityCost).toBeCloseTo(expectedAvailabilityCost(best.vector, stock), 10);
  });
});
