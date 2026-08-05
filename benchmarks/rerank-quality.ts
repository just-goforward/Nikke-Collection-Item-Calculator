import type { ExactInteractiveEvaluation } from "./evaluator/exact-replan-types";

export const QUALITY_PROBABILITY_EPSILON = 1e-12;
export const QUALITY_COST_EPSILON = 1e-12;
export const QUALITY_TOTAL_USES_EPSILON = 1e-9;

export type McExactCalibration =
  | "consistent_with_sampling_error"
  | "outside_nominal_95_interval"
  | "unavailable";

export type CandidateGrade =
  | "product_candidate"
  | "research_tradeoff"
  | "rejected"
  | "verification_incomplete";

export function classifyMcExactCalibration(
  mcMeanDelta: number | null,
  standardError: number | null,
  exactDelta: number | null,
): {
  classification: McExactCalibration;
  standardizedError: number | null;
} {
  if (
    mcMeanDelta === null ||
    standardError === null ||
    exactDelta === null ||
    !Number.isFinite(mcMeanDelta) ||
    !Number.isFinite(standardError) ||
    !Number.isFinite(exactDelta) ||
    standardError < 0
  ) {
    return { classification: "unavailable", standardizedError: null };
  }
  const absoluteError = Math.abs(mcMeanDelta - exactDelta);
  if (standardError === 0) {
    return {
      classification:
        absoluteError <= QUALITY_COST_EPSILON
          ? "consistent_with_sampling_error"
          : "outside_nominal_95_interval",
      standardizedError: absoluteError <= QUALITY_COST_EPSILON ? 0 : Number.POSITIVE_INFINITY,
    };
  }
  const standardizedError = absoluteError / standardError;
  return {
    classification:
      standardizedError <= 1.96 ? "consistent_with_sampling_error" : "outside_nominal_95_interval",
    standardizedError,
  };
}

function totalExpectedUses(result: Extract<ExactInteractiveEvaluation, { status: "completed" }>) {
  return (
    (result.expectedConsumption.blue +
      result.expectedConsumption.purple +
      result.expectedConsumption.yellow) /
    10
  );
}

function completedDeltas(
  baseline: Extract<ExactInteractiveEvaluation, { status: "completed" }>,
  candidate: Extract<ExactInteractiveEvaluation, { status: "completed" }>,
) {
  return {
    probability: candidate.successProbability - baseline.successProbability,
    cost: candidate.interactiveF - baseline.interactiveF,
    totalUses: totalExpectedUses(candidate) - totalExpectedUses(baseline),
  };
}

export function classifyExactInteractiveCandidate(
  baseline: ExactInteractiveEvaluation,
  candidate: ExactInteractiveEvaluation,
): CandidateGrade {
  if (baseline.status !== "completed") {
    return "verification_incomplete";
  }
  if (candidate.status === "solver_failure") return "rejected";
  if (candidate.status !== "completed") return "verification_incomplete";
  if (
    candidate.gateEvidence.internalViolationCount > 0 ||
    candidate.gateEvidence.boundaryViolationCount > 0
  ) {
    return "rejected";
  }

  const {
    probability: probabilityDelta,
    cost: costDelta,
    totalUses: totalUsesDelta,
  } = completedDeltas(baseline, candidate);
  const probabilityNonWorse = probabilityDelta >= -QUALITY_PROBABILITY_EPSILON;
  const costNonWorse = costDelta <= QUALITY_COST_EPSILON;
  const totalUsesNonWorse = totalUsesDelta <= QUALITY_TOTAL_USES_EPSILON;
  const strictBenefit =
    probabilityDelta > QUALITY_PROBABILITY_EPSILON || costDelta < -QUALITY_COST_EPSILON;

  if (probabilityNonWorse && costNonWorse && totalUsesNonWorse) {
    return strictBenefit ? "product_candidate" : "rejected";
  }
  return strictBenefit ? "research_tradeoff" : "rejected";
}

export function classifyExactInteractiveCandidateSet(
  records: ReadonlyArray<{
    baseline: ExactInteractiveEvaluation;
    candidate: ExactInteractiveEvaluation;
  }>,
  latencyGatePassed: boolean,
): CandidateGrade {
  if (records.length === 0) return "verification_incomplete";
  let strictBenefit = false;
  let hasTradeoff = false;
  for (const { baseline, candidate } of records) {
    if (baseline.status !== "completed") return "verification_incomplete";
    if (candidate.status === "solver_failure") return "rejected";
    if (candidate.status !== "completed") return "verification_incomplete";
    if (
      candidate.gateEvidence.internalViolationCount > 0 ||
      candidate.gateEvidence.boundaryViolationCount > 0
    ) {
      return "rejected";
    }
    const deltas = completedDeltas(baseline, candidate);
    strictBenefit ||=
      deltas.probability > QUALITY_PROBABILITY_EPSILON || deltas.cost < -QUALITY_COST_EPSILON;
    hasTradeoff ||=
      deltas.probability < -QUALITY_PROBABILITY_EPSILON ||
      deltas.cost > QUALITY_COST_EPSILON ||
      deltas.totalUses > QUALITY_TOTAL_USES_EPSILON;
  }
  if (hasTradeoff || !latencyGatePassed) {
    return strictBenefit ? "research_tradeoff" : "rejected";
  }
  return strictBenefit ? "product_candidate" : "rejected";
}
