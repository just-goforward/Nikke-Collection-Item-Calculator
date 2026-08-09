import type { Kit, Stock } from "../src/types";
import type { ExactInteractiveEvaluation } from "./evaluator/exact-replan-types";

const KITS: readonly Kit[] = ["blue", "purple", "yellow"];

export const BOUNDED_HYBRID_QUALITY_POLICY = {
  id: "success_or_interactive_f_benefit_all_nonworse_v1",
  successEpsilon: 1e-12,
  interactiveFEpsilon: 1e-12,
  totalUsesEpsilon: 1e-9,
  exhaustionEpsilon: 1e-12,
} as const;

export type BoundedHybridQualityGrade =
  | "scenario_pass"
  | "quality_tradeoff"
  | "quality_rejected"
  | "verification_incomplete";

export type BoundedHybridQualityDecision = {
  grade: BoundedHybridQualityGrade;
  deltas: {
    successProbability: number | null;
    interactiveF: number | null;
    totalExpectedUses: number | null;
    exhaustionProbability: Stock | null;
    expectedManualEntries: number | null;
  };
  gates: {
    bothCompleted: boolean;
    successNonWorse: boolean;
    interactiveFNonWorse: boolean;
    totalUsesNonWorse: boolean;
    exhaustionNonWorse: boolean;
    probabilityAuditPassed: boolean;
    strictBenefit: boolean;
  };
  reasons: string[];
};

export function classifyBoundedHybridQuality(
  baseline: ExactInteractiveEvaluation,
  candidate: ExactInteractiveEvaluation,
): BoundedHybridQualityDecision {
  if (baseline.status !== "completed" || candidate.status !== "completed") {
    return {
      grade: "verification_incomplete",
      deltas: emptyDeltas(),
      gates: {
        bothCompleted: false,
        successNonWorse: false,
        interactiveFNonWorse: false,
        totalUsesNonWorse: false,
        exhaustionNonWorse: false,
        probabilityAuditPassed: false,
        strictBenefit: false,
      },
      reasons: [
        `Exact evaluation incomplete: baseline=${baseline.status}, candidate=${candidate.status}.`,
      ],
    };
  }

  const deltas = {
    successProbability: candidate.successProbability - baseline.successProbability,
    interactiveF: candidate.interactiveF - baseline.interactiveF,
    totalExpectedUses:
      totalUses(candidate.expectedConsumption) - totalUses(baseline.expectedConsumption),
    exhaustionProbability: stockDelta(
      candidate.exhaustionProbability,
      baseline.exhaustionProbability,
    ),
    expectedManualEntries: candidate.expectedManualEntries - baseline.expectedManualEntries,
  };
  const policy = BOUNDED_HYBRID_QUALITY_POLICY;
  const gates = {
    bothCompleted: true,
    successNonWorse: deltas.successProbability >= -policy.successEpsilon,
    interactiveFNonWorse: deltas.interactiveF <= policy.interactiveFEpsilon,
    totalUsesNonWorse: deltas.totalExpectedUses <= policy.totalUsesEpsilon,
    exhaustionNonWorse: KITS.every(
      (kit) => deltas.exhaustionProbability[kit] <= policy.exhaustionEpsilon,
    ),
    probabilityAuditPassed:
      candidate.gateEvidence.internalViolationCount === 0 &&
      candidate.gateEvidence.internalFixedToleranceViolationCount === 0 &&
      candidate.gateEvidence.boundaryViolationCount === 0 &&
      candidate.gateEvidence.boundaryFixedToleranceViolationCount === 0,
    strictBenefit:
      deltas.successProbability > policy.successEpsilon ||
      deltas.interactiveF < -policy.interactiveFEpsilon,
  };
  const allNonWorse =
    gates.successNonWorse &&
    gates.interactiveFNonWorse &&
    gates.totalUsesNonWorse &&
    gates.exhaustionNonWorse &&
    gates.probabilityAuditPassed;
  const grade = allNonWorse
    ? "scenario_pass"
    : gates.strictBenefit
      ? "quality_tradeoff"
      : "quality_rejected";
  return { grade, deltas, gates, reasons: failedReasons(gates) };
}

function totalUses(stock: Stock): number {
  return (stock.blue + stock.purple + stock.yellow) / 10;
}

function stockDelta(candidate: Stock, baseline: Stock): Stock {
  return {
    blue: candidate.blue - baseline.blue,
    purple: candidate.purple - baseline.purple,
    yellow: candidate.yellow - baseline.yellow,
  };
}

function emptyDeltas(): BoundedHybridQualityDecision["deltas"] {
  return {
    successProbability: null,
    interactiveF: null,
    totalExpectedUses: null,
    exhaustionProbability: null,
    expectedManualEntries: null,
  };
}

function failedReasons(gates: BoundedHybridQualityDecision["gates"]): string[] {
  const reasons: string[] = [];
  if (!gates.successNonWorse) reasons.push("success_probability_regressed");
  if (!gates.interactiveFNonWorse) reasons.push("interactive_f_regressed");
  if (!gates.totalUsesNonWorse) reasons.push("total_expected_uses_regressed");
  if (!gates.exhaustionNonWorse) reasons.push("kit_exhaustion_probability_regressed");
  if (!gates.probabilityAuditPassed) reasons.push("probability_gate_violation");
  if (!gates.strictBenefit) reasons.push("no_strict_success_or_interactive_f_benefit");
  return reasons;
}
