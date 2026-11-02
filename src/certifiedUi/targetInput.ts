import { q, toWire } from "../../shared/certifiedRational";
import type { CertifiedInput } from "../certified/types";
import type { CertifiedTargetDraft } from "./CertifiedTargetInput";

/** Bound grammar and prospective numerator/denominator digits before any BigInt work. */
export function parseTargetDraft(draft: CertifiedTargetDraft): CertifiedInput["target"] | null {
  if (!draft.enabled) return undefined;
  if (!Number.isInteger(draft.maxDays) || draft.maxDays < 0 || draft.maxDays > 14) return null;
  if (draft.alpha.length > 260 || !/^(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(draft.alpha)) return null;
  const percent = draft.alpha.endsWith("%");
  const text = percent ? draft.alpha.slice(0, -1) : draft.alpha;
  const [whole, fraction = ""] = text.split(".");
  const numerator = `${whole || "0"}${fraction}`;
  const exponent = fraction.length + (percent ? 2 : 0);
  if (numerator.length > 128 || exponent + 1 > 128) return null;
  const alpha = toWire(q(BigInt(numerator), 10n ** BigInt(exponent)));
  if (alpha.numerator.length > 128 || alpha.denominator.length > 128 ||
      BigInt(alpha.numerator) > BigInt(alpha.denominator)) return null;
  return { version: "target-v1", alpha, maxDays: draft.maxDays };
}
