import { cmp, fromWire } from "../../shared/certifiedRational.ts";
import { validateTargetValue } from "../certified/target.ts";
import type { CertifiedInput, CertifiedOutput, CertifiedEvidenceBudget } from "../certified/types.ts";

/** Consistency only; producer authentication and request identity remain runtime-owned. */
export function assertCompletedEvidence(
  output: CertifiedOutput,
  input?: CertifiedInput,
  budget?: CertifiedEvidenceBudget,
  mode: "current" | "result" = "result",
) {
  const evidence = output.completedEvidence;
  if (mode === "current") {
    if (evidence !== undefined) throw new Error("completed_evidence_on_current");
    return;
  }
  const requested = input?.autoRecommendation === true || input?.riskSummary === true;
  const eligible = requested && output.current !== null &&
    output.status === "completed" && output.refusal === null && !output.claimNotice &&
    output.waiting.status !== "claim_required";
  if (evidence === undefined) {
    if (eligible) throw new Error("completed_evidence_missing");
    return;
  }
  if (!evidence || !requested || !output.current || output.claimNotice ||
    output.waiting.status === "claim_required" || evidence.schemaVersion !== 1 ||
    !Array.isArray(evidence.records) || evidence.records.length < 1 || evidence.records.length > 15)
    throw new Error("completed_evidence_protocol");
  let reserved = 0;
  const reserve = (bytes: number) => { reserved += bytes; budget?.reserve(bytes); };
  const check = () => budget?.check();
  try {
    let previous = -1;
    for (const record of evidence.records) {
      check();
      if (!record || !Number.isInteger(record.day) || record.day <= previous ||
        record.day > 14 || (previous === -1 && record.day !== 0))
        throw new Error("completed_evidence_dates");
      previous = record.day;
      validateTargetValue(record.value, check, reserve);
    }
    validateTargetValue(output.current.value, check, reserve);
    const d0 = evidence.records[0]!.value;
    for (const key of ["successP", "weightedExpectedConsumptionB", "expectedTotalConsumptionC"] as const)
      if (cmp(fromWire(d0[key]), fromWire(output.current.value[key])))
        throw new Error("completed_evidence_current");
    for (const i of [0, 1, 2] as const)
      if (cmp(fromWire(d0.expectedConsumed[i]), fromWire(output.current.value.expectedConsumed[i])))
        throw new Error("completed_evidence_current");
    check();
  } finally {
    budget?.release(reserved);
  }
}
