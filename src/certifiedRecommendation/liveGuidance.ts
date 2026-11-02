import type { CertifiedInput, CertifiedOutput, CertifiedEvidenceBudget } from "../certified/types";
import { cmp, fromWire, ONE } from "../../shared/certifiedRational";
import { assertCompletedEvidence } from "../certifiedRuntime/completedBinding";
import {
  mapRecommendationGuidance,
  type RecommendationGuidance,
  type RecommendationResult,
} from "./policy";

export type LiveRecommendationGuidance =
  | (RecommendationGuidance & { readonly reason?: never })
  | { readonly status: "NOW"; readonly reason: "current_success_certain" }
  | { readonly status: "WITHHELD"; readonly reason: "source_uncertain" | "automatic_delay_restricted" };

/** Presentation only. Call after the existing runtime trust and request-binding checks. */
export function liveRecommendationGuidance(
  input: CertifiedInput,
  output: CertifiedOutput | null,
  recommendation: RecommendationResult | null,
  inputTrustError = false,
  budget?: CertifiedEvidenceBudget,
): LiveRecommendationGuidance {
  const current = output?.current;
  const gates = {
    inputTrustError: inputTrustError || output?.status === "refused",
    complete: current?.status === "complete",
    claimRequired: Boolean(output?.claimNotice) || output?.waiting.status === "claim_required",
    currentAction: current?.status === "preserve"
      ? "preserve" as const
      : current?.status === "use_certified" && current.kit !== null && current.uses > 0
        ? "available" as const
        : "unavailable" as const,
  };
  // Current errors, actual completion and claim obligations outrank future advice.
  if (gates.inputTrustError || gates.complete || gates.claimRequired)
    return mapRecommendationGuidance(gates, recommendation);
  if (output === null || recommendation === null || recommendation.status === "INCOMPLETE")
    return { status: "INCOMPLETE" };
  // Source uncertainty concerns the supply forecast, not user-entered current stock.
  // This is not authentication: the caller must retain the live response binding.
  // Never reconstruct D0 from Current, nor infer certainty from display rounding.
  if (recommendation.status === "NOW" && input.snapshot.sourceStatus === "uncertain") {
    assertCompletedEvidence(output, input, budget);
    const d0 = output.completedEvidence?.records[0];
    if (!d0 || d0.day !== 0 || recommendation.day !== 0 ||
      !recommendation.evaluatedDays.includes(0) ||
      cmp(fromWire(d0.value.successP), recommendation.probability) !== 0)
      throw new Error("completed_evidence_recommendation");
    if (cmp(fromWire(d0.value.successP), ONE) === 0) {
      if (gates.currentAction !== "available")
        return mapRecommendationGuidance(gates, recommendation);
      return { status: "NOW", reason: "current_success_certain" };
    }
  }
  if (input.snapshot.sourceStatus !== "healthy")
    return { status: "WITHHELD", reason: "source_uncertain" };
  if (
    input.snapshot.warnings.includes("source_uncertain_no_automatic_delay") ||
    output.waiting.evidence.includes("modeled_forecast_source_uncertain_no_automatic_delay")
  )
    return { status: "WITHHELD", reason: "automatic_delay_restricted" };
  return mapRecommendationGuidance(gates, recommendation);
}
