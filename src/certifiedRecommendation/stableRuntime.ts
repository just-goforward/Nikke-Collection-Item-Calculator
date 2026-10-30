import type { CertifiedInput, CertifiedOutput, CertifiedEvidenceBudget } from "../certified/types";
import { payloadBytes } from "../certifiedRuntime/protocol";
import { liveContext, liveJsonWorkspace, type LiveRequestIdentity } from "./liveRuntime";
import { liveRecommendationEvidence } from "./liveEvidence";
import { liveRecommendationGuidance } from "./liveGuidance";
import { selectStableRecommendation, validateStableRiskPolicy } from "./stablePolicy";

/**
 * Called only after completed/risk evidence binding; never changes Current.
 * When enabled, selection/guidance are authoritative for the internal candidate.
 * Legacy autoRecommendation remains baseline evidence, never a fallback after
 * unconfirmed selection or an error. No frontend caller enables this contract.
 */
export function stableRuntimeRecommendation(
  input: CertifiedInput, output: CertifiedOutput, request: LiveRequestIdentity,
  engine: unknown, forecast: unknown, budget: CertifiedEvidenceBudget,
  lifetime: "response" | "verification" = "response",
) {
  if (input.riskSummary !== true || input.stableRecommendation === undefined)
    throw new Error("stable_recommendation_requires_risk_summary");
  budget.check();
  const workspace = liveJsonWorkspace({ input, request, engine, forecast }) +
    65536 + 64 * payloadBytes({ completed: output.completedEvidence, risk: output.riskSummaries });
  let retained = 0;
  let published = false;
  budget.check();
  try {
    budget.reserve(workspace);
    budget.check();
    validateStableRiskPolicy(input.stableRecommendation);
    const context = liveContext(input, request, engine, forecast);
    const evidence = liveRecommendationEvidence(input, output, context, budget);
    const result = selectStableRecommendation(context, evidence ?? { probabilities: [] },
      output.riskSummaries, input.stableRecommendation);
    budget.check();
    // Use the original baseline solely for its existing safety gates. Do not
    // relabel its global argmax/score as the risk-qualified candidate:
    // baseline.maxW is the global maximum; selection.selectedW belongs only to
    // the qualified day. Only the gated WAIT presentation receives that day.
    const gated = liveRecommendationGuidance(input, output,
      result.stable.status === "NOW" || result.stable.status === "WAIT" ? result.baseline : null,
      false, budget);
    const guidance = gated.status === "WAIT" && result.stable.status === "WAIT"
      ? { status: "WAIT" as const, day: result.stable.day } : gated;
    const bound = { context, policy: result.policy, baseline: result.baseline,
      selection: result.stable, guidance };
    if (lifetime === "response") {
      retained = liveJsonWorkspace(bound);
      budget.reserve(retained);
    }
    budget.check();
    published = true;
    return bound;
  } finally {
    budget.release(workspace);
    if (!published && retained) budget.release(retained);
  }
}
export type StableRuntimeRecommendation = ReturnType<typeof stableRuntimeRecommendation>;
