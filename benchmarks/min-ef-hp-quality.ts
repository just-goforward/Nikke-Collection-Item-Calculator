import type { Kit } from "../src/types";
import type { ExactInteractiveEvaluation } from "./evaluator/exact-replan-types";
import { totalExpectedUses } from "./min-ef-hp-policy";

const KITS = ["blue", "purple", "yellow"] as const satisfies readonly Kit[];

export const HP_QUALITY_POLICY = {
  id: "success_total1pct_exhaustion_nonworse_v1",
  probabilityEpsilon: 1e-12,
  totalUsesRelativeLimit: 1.01,
  totalUsesEpsilon: 1e-9,
  exhaustionEpsilon: 1e-12,
} as const;

export const HP_PERFORMANCE_POLICY = {
  id: "cold10pct5ms_warm15pct50ms_v1",
  warmRelativeFactor: 1.15,
  warmAbsoluteMarginMs: 50,
  coldRelativeFactor: 1.1,
  coldAbsoluteMarginMs: 5,
} as const;

export type HpCandidateGrade =
  | "product_candidate"
  | "research_tradeoff"
  | "rejected"
  | "verification_incomplete";

export type HpExactGateResult = {
  status: "passed" | "failed" | "verification_incomplete";
  violations: Array<
    | "baseline_incomplete"
    | "candidate_incomplete"
    | "candidate_solver_failure"
    | "probability"
    | "total_uses"
    | "exhaustion_blue"
    | "exhaustion_purple"
    | "exhaustion_yellow"
    | "probability_gate"
  >;
  strictImprovement: boolean;
};

export function evaluateHpExactGate(
  baseline: ExactInteractiveEvaluation,
  candidate: ExactInteractiveEvaluation,
): HpExactGateResult {
  if (baseline.status !== "completed") {
    return {
      status: "verification_incomplete",
      violations: ["baseline_incomplete"],
      strictImprovement: false,
    };
  }
  if (candidate.status === "solver_failure") {
    return {
      status: "failed",
      violations: ["candidate_solver_failure"],
      strictImprovement: false,
    };
  }
  if (candidate.status !== "completed") {
    return {
      status: "verification_incomplete",
      violations: ["candidate_incomplete"],
      strictImprovement: false,
    };
  }

  const violations: HpExactGateResult["violations"] = [];
  if (
    candidate.successProbability <
    baseline.successProbability - HP_QUALITY_POLICY.probabilityEpsilon
  ) {
    violations.push("probability");
  }
  if (
    totalExpectedUses(candidate) >
    totalExpectedUses(baseline) * HP_QUALITY_POLICY.totalUsesRelativeLimit +
      HP_QUALITY_POLICY.totalUsesEpsilon
  ) {
    violations.push("total_uses");
  }
  for (const kit of KITS) {
    if (
      candidate.exhaustionProbability[kit] >
      baseline.exhaustionProbability[kit] + HP_QUALITY_POLICY.exhaustionEpsilon
    ) {
      violations.push(`exhaustion_${kit}`);
    }
  }
  if (
    candidate.gateEvidence.internalViolationCount > 0 ||
    candidate.gateEvidence.boundaryViolationCount > 0
  ) {
    violations.push("probability_gate");
  }

  const strictImprovement =
    candidate.successProbability >
      baseline.successProbability + HP_QUALITY_POLICY.probabilityEpsilon ||
    totalExpectedUses(candidate) <
      totalExpectedUses(baseline) - HP_QUALITY_POLICY.totalUsesEpsilon ||
    KITS.some(
      (kit) =>
        candidate.exhaustionProbability[kit] <
        baseline.exhaustionProbability[kit] - HP_QUALITY_POLICY.exhaustionEpsilon,
    );
  return {
    status: violations.length === 0 ? "passed" : "failed",
    violations,
    strictImprovement,
  };
}

export function passesHpPerformanceGate(input: {
  baselineColdP95Ms: number | null;
  candidateColdP95Ms: number | null;
  baselineWarmP95Ms: number | null;
  candidateWarmP95Ms: number | null;
}): boolean {
  if (Object.values(input).some((value) => value === null)) return false;
  const baselineCold = input.baselineColdP95Ms as number;
  const candidateCold = input.candidateColdP95Ms as number;
  const baselineWarm = input.baselineWarmP95Ms as number;
  const candidateWarm = input.candidateWarmP95Ms as number;
  return (
    candidateCold <=
      Math.max(
        baselineCold * HP_PERFORMANCE_POLICY.coldRelativeFactor,
        baselineCold + HP_PERFORMANCE_POLICY.coldAbsoluteMarginMs,
      ) &&
    candidateWarm <=
      Math.max(
        baselineWarm * HP_PERFORMANCE_POLICY.warmRelativeFactor,
        baselineWarm + HP_PERFORMANCE_POLICY.warmAbsoluteMarginMs,
      )
  );
}

export function classifyHpCandidate(input: {
  exactGates: readonly HpExactGateResult[];
  tailRiskPassed: boolean | null;
  d1RobustnessPassed: boolean | null;
  performancePassed: boolean | null;
  hasStrictTailImprovement: boolean;
  hasNewFailure: boolean;
}): HpCandidateGrade {
  if (
    input.exactGates.length === 0 ||
    input.exactGates.some((gate) => gate.status === "verification_incomplete")
  ) {
    return "verification_incomplete";
  }
  const failedGates = input.exactGates.filter((gate) => gate.status === "failed");
  const totalUsesOnlyViolation =
    failedGates.length > 0 &&
    failedGates.every((gate) => gate.violations.every((item) => item === "total_uses"));
  if (input.hasNewFailure || failedGates.length > 0) {
    return totalUsesOnlyViolation ? "research_tradeoff" : "rejected";
  }
  if (
    input.tailRiskPassed === false ||
    input.d1RobustnessPassed === false ||
    input.performancePassed === false
  ) {
    return "rejected";
  }
  if (
    input.tailRiskPassed === null ||
    input.d1RobustnessPassed === null ||
    input.performancePassed === null
  ) {
    return "verification_incomplete";
  }
  const strictExactImprovement = input.exactGates.some((gate) => gate.strictImprovement);
  return strictExactImprovement || input.hasStrictTailImprovement
    ? "product_candidate"
    : "rejected";
}
