import type { CertifiedMinimumWait } from "../certified/types";
import type { CertifiedWords } from "./messages";

/** H56 dates and incomplete label proofs are deliberately never substituted. */
export function minimumWaitText(
  value: CertifiedMinimumWait | undefined,
  words: CertifiedWords,
): string {
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
