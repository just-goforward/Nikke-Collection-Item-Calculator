import { CertifiedLimit, reserveTargetPayload, type WorkBudget } from "./budget";
import { assertCompletedCurrent, validateTargetValue } from "./target";
import type { CertifiedInput, CertifiedOutput, CompletedDate } from "./types";

/** One opt-in wire envelope serves both consumers; neither changes date exploration. */
export function completedEvidenceRequested(input: CertifiedInput): boolean {
  return input.target !== undefined || input.autoRecommendation === true || input.riskSummary === true;
}

/** Retain the same decoded array, not a second evidence vector or inferred dates. */
export function bindCompletedEvidence(
  output: CertifiedOutput,
  input: CertifiedInput,
  records: CompletedDate[],
  budget: WorkBudget,
): void {
  if ((input.autoRecommendation !== true && input.riskSummary !== true) || !output.current || output.claimNotice) return;
  budget.check();
  const current = output.current.value;
  const first = records[0];
  const replacesD0 = first?.day === 0;
  // Producers already require sorted, unique days in 0..14. Include the
  // established Current slot in admission rather than ever emitting 16 rows.
  if (records.length + (replacesD0 ? 0 : 1) > 15)
    throw new CertifiedLimit("target_completed_dates_protocol");
  const previousD0 = first?.value;
  let workspaceBytes = 0;
  let retainedEnvelope = false;
  let changed = false;
  try {
    // Validation temporaries are not retained evidence. The reserve API charges
    // even rejected attempts, so release every attempted workspace byte below.
    validateTargetValue(current, budget.check, bytes => {
      workspaceBytes += bytes;
      budget.reserve(bytes);
    });
    if (replacesD0) assertCompletedCurrent(current, first);
    // Envelope plus the possible D0 slot; Current's exact vector is already owned.
    reserveTargetPayload(budget, 128);
    retainedEnvelope = true;
    if (replacesD0) {
      // H7 may choose different colors within an exact P/B/C tie.
      first.value = current;
    } else {
      records.unshift({ day: 0, value: current });
    }
    changed = true;
    budget.check();
    output.completedEvidence = { schemaVersion: 1, records };
  } catch (error) {
    if (changed) {
      if (replacesD0) first.value = previousD0!;
      else records.shift();
    }
    if (retainedEnvelope) budget.release(128);
    throw error;
  } finally {
    budget.release(workspaceBytes);
  }
}
