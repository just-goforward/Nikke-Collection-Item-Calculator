import { STRATEGY_PROBABILITY_TOLERANCE } from "../../src/solver/domain";
import type { ProbabilityGateAudit } from "../../src/solver/solve";
import type { CollectionState, Stock } from "../../src/types";
import type { GateEvidence } from "./exact-replan-types";

const EPSILON = 1e-12;

export function createGateEvidence(): GateEvidence {
  return {
    internalDecisionCount: 0,
    internalMaxGap: 0,
    internalMaxGapWitness: null,
    internalViolationCount: 0,
    internalFirstViolationWitness: null,
    internalEligibleEmptyCount: 0,
    internalFixedToleranceViolationCount: 0,
    internalFirstFixedToleranceViolationWitness: null,
    boundaryDecisionCount: 0,
    boundaryMaxGap: 0,
    boundaryMaxGapWitness: null,
    boundaryViolationCount: 0,
    boundaryFirstViolationWitness: null,
    boundaryFixedToleranceViolationCount: 0,
    boundaryFirstFixedToleranceViolationWitness: null,
  };
}

export function mergeInternalAudit(
  evidence: GateEvidence,
  audit: ProbabilityGateAudit | undefined,
  boundaryState: CollectionState,
  boundaryPhysicalStock: Stock,
) {
  if (!audit) return;
  evidence.internalDecisionCount += audit.decisionCount;
  evidence.internalViolationCount += audit.violationCount;
  evidence.internalEligibleEmptyCount += audit.eligibleEmptyCount;
  evidence.internalFixedToleranceViolationCount += audit.fixedToleranceViolationCount;
  if (audit.maxGapWitness && audit.maxGap > evidence.internalMaxGap) {
    evidence.internalMaxGap = audit.maxGap;
    evidence.internalMaxGapWitness = {
      boundaryState: { ...boundaryState },
      boundaryPhysicalStock: { ...boundaryPhysicalStock },
      mdpWitness: audit.maxGapWitness,
    };
  }
  if (!evidence.internalFirstViolationWitness && audit.firstViolationWitness) {
    evidence.internalFirstViolationWitness = {
      boundaryState: { ...boundaryState },
      boundaryPhysicalStock: { ...boundaryPhysicalStock },
      mdpWitness: audit.firstViolationWitness,
    };
  }
  if (
    !evidence.internalFirstFixedToleranceViolationWitness &&
    audit.firstFixedToleranceViolationWitness
  ) {
    evidence.internalFirstFixedToleranceViolationWitness = {
      boundaryState: { ...boundaryState },
      boundaryPhysicalStock: { ...boundaryPhysicalStock },
      mdpWitness: audit.firstFixedToleranceViolationWitness,
    };
  }
}

export function recordBoundaryGap(
  evidence: GateEvidence,
  state: CollectionState,
  stock: Stock,
  gap: number,
  tolerance: number,
) {
  const witness = { gap, state: { ...state }, physicalStock: { ...stock } };
  evidence.boundaryDecisionCount += 1;
  if (gap > evidence.boundaryMaxGap) {
    evidence.boundaryMaxGap = gap;
    evidence.boundaryMaxGapWitness = witness;
  }
  if (gap > tolerance + EPSILON) {
    evidence.boundaryViolationCount += 1;
    if (!evidence.boundaryFirstViolationWitness) {
      evidence.boundaryFirstViolationWitness = witness;
    }
  }
  if (gap > STRATEGY_PROBABILITY_TOLERANCE.supply + EPSILON) {
    evidence.boundaryFixedToleranceViolationCount += 1;
    if (!evidence.boundaryFirstFixedToleranceViolationWitness) {
      evidence.boundaryFirstFixedToleranceViolationWitness = witness;
    }
  }
}
