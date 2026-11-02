import { decodeRiskSummaries } from "../certified/riskSummary.ts";
import type { CertifiedInput, CertifiedOutput, CertifiedEvidenceBudget } from "../certified/types.ts";
import { liveContext, liveJsonWorkspace, type LiveRequestIdentity } from "../certifiedRecommendation/liveRuntime.ts";

export function riskBinding(
  output: CertifiedOutput, input: CertifiedInput | undefined,
  budget: CertifiedEvidenceBudget | undefined, mode: "current" | "result",
  request: LiveRequestIdentity | undefined, engine: unknown, forecast: unknown,
  lifetime: "response" | "verification" = "response",
) {
  if (output.riskSummaries === undefined) {
    if (input?.riskSummary === true && mode === "result" && output.current &&
      !output.claimNotice && output.completedEvidence &&
      (output.waiting.status === "certified" || output.waiting.status === "unresolved"))
      throw new Error("risk_summaries_missing");
    return undefined;
  }
  if (input?.riskSummary !== true || mode !== "result" || !request || !budget ||
    !output.current || output.claimNotice || !output.completedEvidence)
    throw new Error("risk_summary_binding_missing");
  const workspace = liveJsonWorkspace({ input, request, engine, forecast, pricing: output.pricing,
    current: output.current, summaries: output.riskSummaries });
  let retained = 0;
  let published = false;
  try {
    budget.reserve(workspace);
    decodeRiskSummaries(output.riskSummaries, true, output.completedEvidence.records, budget);
    // Producer copies remain charged to the request through serialization/post.
    // Verification's caller admits and holds the returned comparison copy.
    if (lifetime === "response") {
      retained = workspace;
      budget.reserve(retained);
    }
    const result = {
      context: liveContext(input, request, engine, forecast),
      pricing: structuredClone(output.pricing),
      current: structuredClone(output.current),
      policyVersion: output.riskSummaries.policyVersion,
      summaries: structuredClone(output.riskSummaries),
    };
    budget.check();
    published = true;
    return result;
  } finally {
    budget.release(workspace);
    if (!published && retained) budget.release(retained);
  }
}
