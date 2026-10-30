import { cmp, ONE, q, type Q, sub, ZERO } from "../../shared/certifiedRational";
import {
  type RecommendationContext,
  type RecommendationEvidence,
  RecommendationEvidenceError,
  validateRecommendationEvidence,
} from "./evidence";

/** Experimental standalone policy, NOT an adopted product/runtime contract. */
export const RECOMMENDATION_POLICY_VERSION = "experimental-w-selector-v1" as const;
export const RECOMMENDATION_HORIZON_DAYS = 14 as const;
export const RECOMMENDATION_DELTA: Q = Object.freeze(q(1, 200));

type Coverage = "all_dates" | "universal_probability_bound" | "existing_f_upper_attainment";

interface ResultBase {
  readonly policyVersion: typeof RECOMMENDATION_POLICY_VERSION;
  readonly evaluatedDays: readonly number[];
  readonly excludedDays: readonly number[];
}

export type RecommendationResult =
  | (ResultBase & {
      readonly status: "INCOMPLETE";
      /** Missing dates not excluded by a verified attained upper bound. */
      readonly missingDays: readonly number[];
    })
  | (ResultBase & {
      readonly status: "NOW" | "WAIT";
      readonly day: number;
      readonly probability: Q;
      /** max over the entire 0..14 domain, including W(0) = 0. */
      readonly maxW: Q;
      /** score(0) = P0; score(d>0) = Pd - d/400 - delta. */
      readonly score: Q;
      readonly completeBy: Coverage;
    });

/**
 * Pure exact selection; no solver invocation, interpolation, history or action gate.
 * Invalid/corrupt/unbound evidence throws RecommendationEvidenceError, never INCOMPLETE.
 */
export function selectRecommendation(
  expectedContext: RecommendationContext,
  evidence: RecommendationEvidence,
): RecommendationResult {
  const { probabilities, upperAttainment } = validateRecommendationEvidence(expectedContext, evidence);
  let attainedDay: number | null = null;
  let completeBy: Coverage = "all_dates";
  // P <= 1 is universal: an actual P(a) = 1 needs no F producer theorem.
  for (let d = 0; d <= RECOMMENDATION_HORIZON_DAYS; d++) {
    const p = probabilities.get(d);
    if (p !== undefined && cmp(p, ONE) === 0) {
      attainedDay = d;
      completeBy = "universal_probability_bound";
      break;
    }
  }
  if (
    upperAttainment !== null &&
    probabilities.has(upperAttainment.attainedDay) &&
    (attainedDay === null || upperAttainment.attainedDay < attainedDay)
  ) {
    attainedDay = upperAttainment.attainedDay;
    completeBy = "existing_f_upper_attainment";
  }

  const evaluatedDays: number[] = [];
  const excludedDays: number[] = [];
  const missingDays: number[] = [];
  for (let d = 0; d <= RECOMMENDATION_HORIZON_DAYS; d++) {
    if (probabilities.has(d)) evaluatedDays.push(d);
    else if (attainedDay !== null && d > attainedDay) excludedDays.push(d);
    else missingDays.push(d);
  }
  const base: ResultBase = {
    policyVersion: RECOMMENDATION_POLICY_VERSION,
    evaluatedDays,
    excludedDays,
  };
  // This also requires the actual P0 and every date through attainment.
  if (missingDays.length > 0) return { ...base, status: "INCOMPLETE", missingDays };
  if (excludedDays.length === 0) completeBy = "all_dates";

  const p0 = probabilities.get(0)!;
  let bestDay = 0;
  let bestP = p0;
  let maxW = ZERO;
  // Ascending traversal with strict improvement gives the earliest exact argmax.
  // Rank the entire available prefix, never copy the F attainment/recommendation day.
  for (const d of evaluatedDays) {
    const p = probabilities.get(d)!;
    const w = sub(sub(p, p0), q(d, 400));
    if (cmp(w, maxW) > 0) {
      bestDay = d;
      bestP = p;
      maxW = w;
    }
  }
  if (cmp(maxW, RECOMMENDATION_DELTA) <= 0)
    return {
      ...base,
      status: "NOW",
      day: 0,
      probability: p0,
      maxW,
      score: p0,
      completeBy,
    };
  return {
    ...base,
    status: "WAIT",
    day: bestDay,
    probability: bestP,
    maxW,
    score: sub(sub(bestP, q(bestDay, 400)), RECOMMENDATION_DELTA),
    completeBy,
  };
}

export interface RecommendationCurrentGates {
  /** Includes input, trust, binding and corrupt-evidence failures; highest priority. */
  readonly inputTrustError: boolean;
  /** Actual game state, never inferred from a probability of one. */
  readonly complete: boolean;
  readonly claimRequired: boolean;
  readonly currentAction: "available" | "preserve" | "unavailable";
}

export type RecommendationGuidance =
  | { readonly status: "ERROR" | "COMPLETE" | "CLAIM_REQUIRED" | "INCOMPLETE" | "NOW" | "PRESERVE" | "UNAVAILABLE" }
  | { readonly status: "WAIT"; readonly day: number };

/** Presentation-only mapping; it neither changes the numerical result nor executes an action. */
export function mapRecommendationGuidance(
  gates: RecommendationCurrentGates,
  recommendation: RecommendationResult | null,
): RecommendationGuidance {
  if (
    !gates ||
    typeof gates.inputTrustError !== "boolean" ||
    typeof gates.complete !== "boolean" ||
    typeof gates.claimRequired !== "boolean" ||
    !["available", "preserve", "unavailable"].includes(gates.currentAction)
  )
    throw new RecommendationEvidenceError("invalid_input", "Invalid current guidance gates.");
  if (gates.inputTrustError) return { status: "ERROR" };
  if (gates.complete) return { status: "COMPLETE" };
  if (gates.claimRequired) return { status: "CLAIM_REQUIRED" };
  if (recommendation === null || recommendation.status === "INCOMPLETE")
    return { status: "INCOMPLETE" };
  // Lack of a current action must not suppress a valid future WAIT.
  if (recommendation.status === "WAIT") return { status: "WAIT", day: recommendation.day };
  if (gates.currentAction === "preserve") return { status: "PRESERVE" };
  if (gates.currentAction === "unavailable") return { status: "UNAVAILABLE" };
  return { status: "NOW" };
}
