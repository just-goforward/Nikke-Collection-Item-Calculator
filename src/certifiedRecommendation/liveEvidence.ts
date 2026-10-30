import { fromWire } from "../../shared/certifiedRational";
import type { RecommendationContext, RecommendationEvidence } from "./evidence";
import { RecommendationEvidenceError, validateRecommendationEvidence } from "./evidence";
import type { CertifiedInput, CertifiedOutput, CertifiedEvidenceBudget } from "../certified/types";
import { assertCompletedEvidence } from "../certifiedRuntime/completedBinding";

/** Internal adapter; only authenticated, envelope-bound runtime responses belong here. */
export function liveRecommendationEvidence(
  input: CertifiedInput,
  output: CertifiedOutput,
  context: RecommendationContext,
  budget: CertifiedEvidenceBudget,
): RecommendationEvidence | null {
  if (context.asOf !== input.asOf)
    throw new RecommendationEvidenceError("binding_mismatch", "Recommendation asOf mismatch.");
  assertCompletedEvidence(output, input, budget);
  if (!output.completedEvidence) return null;
  const evidence: RecommendationEvidence = {
    probabilities: output.completedEvidence.records.map(record => ({
      context: Object.freeze({ ...context }),
      day: record.day,
      probability: fromWire(record.value.successP),
    })),
  };
  validateRecommendationEvidence(context, evidence);
  return evidence;
}
