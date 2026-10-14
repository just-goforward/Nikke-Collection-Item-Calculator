import type { CertifiedMinimumWait } from "../certified/types";
import type { CertifiedWords } from "./messages";

export function minimumWaitCalculating(
  value: CertifiedMinimumWait | undefined,
  busy: boolean,
): boolean {
  return (
    busy &&
    (!value ||
      value.reason === "minimum_wait_in_progress" ||
      value.reason === "current_not_completed")
  );
}

/** H56 dates and incomplete label proofs are deliberately never substituted. */
export function minimumWaitText(
  value: CertifiedMinimumWait | undefined,
  words: CertifiedWords,
  busy = false,
): string {
  if (minimumWaitCalculating(value, busy)) return words.minimumWaitCalculating;
  if (!value) return words.minimumWaitUnknown;
  if (value.status === "certified" && value.minimumDays !== null)
    return words.minimumWaitDays.replace("{n}", String(value.minimumDays));
  if (value.status === "beyond_horizon") return words.minimumWaitBeyond;
  if (value.status === "not_applicable" || value.status === "not_requested") return words.NA;
  if (value.latestPossibleDay !== null && value.earliestPossibleDay !== null)
    return words.minimumWaitInterval
      .replace("{from}", String(value.earliestPossibleDay))
      .replace("{to}", String(value.latestPossibleDay));
  if ((value.earliestPossibleDay ?? 1) > 1)
    return words.minimumWaitLower.replace("{n}", String(value.earliestPossibleDay));
  return words.minimumWaitUnknown;
}

export function minimumWaitReason(
  value: CertifiedMinimumWait | undefined,
  words: CertifiedWords,
  busy: boolean,
): string | null {
  if (value?.status !== "unknown" || minimumWaitCalculating(value, busy)) return null;
  switch (value.reason) {
    case "current_claimable_unreceived":
      return words.claimRequired;
    case "request_budget_exhausted":
    case "worker_total_deadline":
      return words.minimumWaitBudget;
    case "exact_memo_limit":
    case "exact_support_limit":
    case "managed_payload_ceiling":
    case "minimum_wait_bound_cache_unavailable":
    case "minimum_wait_grid_overflow":
      return words.minimumWaitGuard;
    case "minimum_wait_future_coverage_incomplete":
      return words.minimumWaitCoverage;
    case "worker_abort":
      return words.minimumWaitInterrupted;
    default:
      return `${words.minimumWaitUnconfirmed}: ${value.reason ?? words.NA}`;
  }
}
