import type { SolverInput } from "../src/types";

export const CONDITIONAL_EXACT_RESCUE_RULE = {
  id: "r-low-level-high-stock-balanced-or-half-scarcity-v1",
  grade: "R",
  maximumLevel: 7,
  minimumTotalPieces: 600,
  balancedMaximumPieces: 220,
  scarcityCondition: "minimumPieces * 2 <= maximumPieces",
  applicationPoint: "after_min_ef_tier21_capacity_failure",
  evidenceScope: "exploratory_rule_derived_from_discovery_and_confirmation",
} as const;

export const SOLVER_PORTFOLIO_ROUTING_CONTRACT = {
  horizonFactor: 0.75,
  normPower: 3,
  tolerance: 0,
  minEfTier: 21,
  rescueTier: 22,
  phase2Tier: 22,
  minEfNodeBudget: 2_000_000,
  rescueNodeBudget: 4_000_000,
  branchBoundMode: 2,
  latencyGate: { relativeFactor: 1.15, absoluteMarginMs: 50 },
  conditionalRule: CONDITIONAL_EXACT_RESCUE_RULE,
} as const;

export function conditionalExactRescueEligible(input: Pick<SolverInput, "start" | "stock">) {
  if (input.start.grade !== "R" || input.start.level > CONDITIONAL_EXACT_RESCUE_RULE.maximumLevel) {
    return false;
  }
  const pieces = [input.stock.blue, input.stock.purple, input.stock.yellow];
  const total = pieces.reduce((sum, value) => sum + value, 0);
  const minimum = Math.min(...pieces);
  const maximum = Math.max(...pieces);
  return (
    total >= CONDITIONAL_EXACT_RESCUE_RULE.minimumTotalPieces &&
    (maximum <= CONDITIONAL_EXACT_RESCUE_RULE.balancedMaximumPieces || minimum * 2 <= maximum)
  );
}

export function portfolioRouteLatencyPassed(baselineMs: number, candidateMs: number) {
  const gate = SOLVER_PORTFOLIO_ROUTING_CONTRACT.latencyGate;
  return (
    candidateMs <= Math.max(baselineMs * gate.relativeFactor, baselineMs + gate.absoluteMarginMs)
  );
}
