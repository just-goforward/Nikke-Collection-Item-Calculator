import type { CollectionState, KitVector, Strategy } from "./domain";
import {
  STRATEGY_DEFAULT,
  STRATEGY_PROBABILITY_TOLERANCE,
  STRICT_EPSILON,
  totalKits,
} from "./domain";

export type ProbabilityGateWitness = {
  gap: number;
  state: CollectionState;
  stockUses: KitVector;
};

export type ProbabilityGateAudit = {
  decisionCount: number;
  maxGap: number;
  maxGapWitness: ProbabilityGateWitness | null;
  violationCount: number;
  firstViolationWitness: ProbabilityGateWitness | null;
  eligibleEmptyCount: number;
  fixedToleranceViolationCount: number;
  firstFixedToleranceViolationWitness: ProbabilityGateWitness | null;
};

type ComparableCandidate = {
  resourceCost: number;
  pressure: number;
  vector: KitVector;
  successProbability: number;
};

export function createProbabilityGateAudit(): ProbabilityGateAudit {
  return {
    decisionCount: 0,
    maxGap: 0,
    maxGapWitness: null,
    violationCount: 0,
    firstViolationWitness: null,
    eligibleEmptyCount: 0,
    fixedToleranceViolationCount: 0,
    firstFixedToleranceViolationWitness: null,
  };
}

export function recordProbabilityGateDecision(
  audit: ProbabilityGateAudit,
  gap: number,
  tolerance: number,
  eligibleEmpty: boolean,
  state: CollectionState,
  stockUses: KitVector,
) {
  audit.decisionCount += 1;
  if (eligibleEmpty) audit.eligibleEmptyCount += 1;
  if (gap > audit.maxGap) {
    audit.maxGap = gap;
    audit.maxGapWitness = { gap, state: { ...state }, stockUses: { ...stockUses } };
  }
  if (gap > tolerance + STRICT_EPSILON) {
    audit.violationCount += 1;
    if (!audit.firstViolationWitness) {
      audit.firstViolationWitness = { gap, state: { ...state }, stockUses: { ...stockUses } };
    }
  }
  if (gap > STRATEGY_PROBABILITY_TOLERANCE.supply + STRICT_EPSILON) {
    audit.fixedToleranceViolationCount += 1;
    if (!audit.firstFixedToleranceViolationWitness) {
      audit.firstFixedToleranceViolationWitness = {
        gap,
        state: { ...state },
        stockUses: { ...stockUses },
      };
    }
  }
}

export function normalizeStrategy(strategy: unknown): Strategy {
  return strategy === "supply" ? "supply" : STRATEGY_DEFAULT;
}

export function probabilityToleranceForStrategy(strategy: unknown, toleranceOverride?: number) {
  const normalized = normalizeStrategy(strategy);
  if (
    normalized === "supply" &&
    typeof toleranceOverride === "number" &&
    Number.isFinite(toleranceOverride) &&
    toleranceOverride >= 0
  ) {
    return toleranceOverride;
  }
  return STRATEGY_PROBABILITY_TOLERANCE[normalized];
}

export function withinProbabilityTolerance(
  successProbability: number,
  maxSuccessProbability: number,
  strategy: unknown,
  toleranceOverride?: number,
) {
  return (
    maxSuccessProbability - successProbability <=
    probabilityToleranceForStrategy(strategy, toleranceOverride) + STRICT_EPSILON
  );
}

export function compareEfficiency<T extends ComparableCandidate>(
  a: T,
  b: T,
  strategy: Strategy = STRATEGY_DEFAULT,
) {
  if (strategy === "supply") {
    if (Math.abs(a.resourceCost - b.resourceCost) > STRICT_EPSILON)
      return a.resourceCost - b.resourceCost;
  } else if (Math.abs(a.pressure - b.pressure) > STRICT_EPSILON) {
    return a.pressure - b.pressure;
  }
  const totalDiff = totalKits(a.vector) - totalKits(b.vector);
  if (Math.abs(totalDiff) > STRICT_EPSILON) return totalDiff;
  return b.successProbability - a.successProbability;
}

export function chooseEfficientCandidate<T extends ComparableCandidate>(
  candidates: T[],
  maxSuccessProbability: number,
  strategy: Strategy,
  toleranceOverride?: number,
): { best: T | null; eligibleEmpty: boolean } {
  if (!candidates.length) return { best: null, eligibleEmpty: false };
  const eligible = candidates.filter((candidate) =>
    withinProbabilityTolerance(
      candidate.successProbability,
      maxSuccessProbability,
      strategy,
      toleranceOverride,
    ),
  );
  const pool = eligible.length ? eligible : candidates;
  const best = pool.reduce<T | null>((currentBest, candidate) => {
    if (!currentBest) return candidate;
    return compareEfficiency(candidate, currentBest, strategy) < 0 ? candidate : currentBest;
  }, null);
  return { best, eligibleEmpty: eligible.length === 0 };
}

export function compareByStrategy<T extends ComparableCandidate>(
  a: T,
  b: T,
  maxSuccessProbability: number,
  strategy: Strategy,
  toleranceOverride?: number,
) {
  const aEligible = withinProbabilityTolerance(
    a.successProbability,
    maxSuccessProbability,
    strategy,
    toleranceOverride,
  );
  const bEligible = withinProbabilityTolerance(
    b.successProbability,
    maxSuccessProbability,
    strategy,
    toleranceOverride,
  );
  if (aEligible !== bEligible) return aEligible ? -1 : 1;
  if (aEligible && bEligible) return compareEfficiency(a, b, strategy);
  if (Math.abs(a.successProbability - b.successProbability) > STRICT_EPSILON) {
    return b.successProbability - a.successProbability;
  }
  return compareEfficiency(a, b, strategy);
}
