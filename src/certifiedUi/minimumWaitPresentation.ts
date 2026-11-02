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

/** H14 dates and incomplete label proofs are deliberately never substituted. */
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

const reasonWordKeys = new Map<string, keyof CertifiedWords>([
  ["current_claimable_unreceived", "claimRequired"],
  ["request_budget_exhausted", "minimumWaitBudget"],
  ["worker_total_deadline", "minimumWaitBudget"],
  ["exact_memo_limit", "minimumWaitGuard"],
  ["exact_support_limit", "minimumWaitGuard"],
  ["managed_payload_ceiling", "minimumWaitGuard"],
  ["minimum_wait_bound_cache_unavailable", "minimumWaitGuard"],
  ["minimum_wait_grid_overflow", "minimumWaitGuard"],
  ["minimum_wait_future_coverage_incomplete", "minimumWaitCoverage"],
  ["minimum_wait_in_progress", "minimumWaitInterrupted"],
  ["current_not_completed", "minimumWaitInterrupted"],
  ["worker_abort", "minimumWaitInterrupted"],
]);

export function minimumWaitReason(
  value: CertifiedMinimumWait | undefined,
  words: CertifiedWords,
  busy: boolean,
): string | null {
  if (value?.status !== "unknown" || minimumWaitCalculating(value, busy)) return null;
  const key = reasonWordKeys.get(value.reason ?? "");
  if (key !== undefined) return words[key];
  return words.minimumWaitUnconfirmed;
}
