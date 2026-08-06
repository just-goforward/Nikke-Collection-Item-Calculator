import type { ExactInteractiveEvaluation } from "./evaluator/exact-replan-types";

export const QUALITY_CLASSIFICATION_POLICY = {
  id: "p_or_f_benefit_all_nonworse_v1",
  probabilityEpsilon: 1e-12,
  costEpsilon: 1e-12,
  totalUsesEpsilon: 1e-9,
} as const;

export const QUALITY_LATENCY_GATE_POLICY = {
  id: "warm_p95_max_relative_or_absolute_v1",
  relativeFactor: 1.15,
  absoluteMarginMs: 50,
} as const;

export const MC_EXACT_DELTA_ZERO_SE_EPSILON = 1e-12;

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
        absoluteError <= MC_EXACT_DELTA_ZERO_SE_EPSILON
          ? "consistent_with_sampling_error"
          : "outside_nominal_95_interval",
      standardizedError:
        absoluteError <= MC_EXACT_DELTA_ZERO_SE_EPSILON ? 0 : Number.POSITIVE_INFINITY,
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
  const probabilityNonWorse = probabilityDelta >= -QUALITY_CLASSIFICATION_POLICY.probabilityEpsilon;
  const costNonWorse = costDelta <= QUALITY_CLASSIFICATION_POLICY.costEpsilon;
  const totalUsesNonWorse = totalUsesDelta <= QUALITY_CLASSIFICATION_POLICY.totalUsesEpsilon;
  const strictBenefit =
    probabilityDelta > QUALITY_CLASSIFICATION_POLICY.probabilityEpsilon ||
    costDelta < -QUALITY_CLASSIFICATION_POLICY.costEpsilon;

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
      deltas.probability > QUALITY_CLASSIFICATION_POLICY.probabilityEpsilon ||
      deltas.cost < -QUALITY_CLASSIFICATION_POLICY.costEpsilon;
    hasTradeoff ||=
      deltas.probability < -QUALITY_CLASSIFICATION_POLICY.probabilityEpsilon ||
      deltas.cost > QUALITY_CLASSIFICATION_POLICY.costEpsilon ||
      deltas.totalUses > QUALITY_CLASSIFICATION_POLICY.totalUsesEpsilon;
  }
  if (hasTradeoff || !latencyGatePassed) {
    return strictBenefit ? "research_tradeoff" : "rejected";
  }
  return strictBenefit ? "product_candidate" : "rejected";
}

export function passesQualityLatencyGate(
  baselineWarmP95Ms: number | null,
  candidateWarmP95Ms: number | null,
): boolean {
  if (baselineWarmP95Ms === null || candidateWarmP95Ms === null) return false;
  const limit = Math.max(
    baselineWarmP95Ms * QUALITY_LATENCY_GATE_POLICY.relativeFactor,
    baselineWarmP95Ms + QUALITY_LATENCY_GATE_POLICY.absoluteMarginMs,
  );
  return candidateWarmP95Ms <= limit;
}
