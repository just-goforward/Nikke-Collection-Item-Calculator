import { q, sub, toWire } from "../../shared/certifiedRational";
import type { CertifiedSupplyEvent } from "../../shared/certifiedSupply";
import { CertifiedLimit } from "./budget";
import { convolve, expectation, type Support, singleton } from "./distribution";
import { eventOffset, law, waitingBase } from "./events";
import { CAPS } from "./game";
import type { CertifiedWaiting, Triple } from "./types";
import { compareValue, type ExactValue } from "./value";
import type { WaitingContext } from "./waitingContext";

const ONE = q(1);

function advanceSupports(
  context: WaitingContext,
  supports: Support[],
  arrivals: readonly CertifiedSupplyEvent[],
  caps: Triple,
): void {
  for (const cohort of [0, 1, 2] as const) {
    if (context.priors[cohort].n === 0n) continue;
    for (const event of arrivals) {
      for (let i = 0; i < event.refs.length; i++) {
        supports[cohort] = convolve(
          supports[cohort]!,
          law(context.input, event, i, cohort, context.kernel.budget),
          caps,
          context.kernel.budget,
        );
      }
    }
  }
}
function exactDateResult(
  context: WaitingContext,
  values: readonly ExactValue[],
  evaluatedDays: readonly number[],
): CertifiedWaiting {
  const h = values[56]!;
  const earliest = values.findIndex((value) => compareValue(value, h) === 0);
  if (earliest > 0 && compareValue(values[earliest - 1]!, h) >= 0)
    throw new Error("certified_earliest_strictness_failed");
  return {
    ...waitingBase("certified", null),
    recommendedDays: earliest,
    rangeBoundary: earliest === 56,
    bestDayRange: [earliest, earliest],
    value: context.view(h),
    evaluatedDays,
    successProbabilityInterval: { lower: toWire(h.p), upper: toWire(h.p) },
    successImprovementUpperBound: toWire(sub(ONE, h.p)),
    evidence: [
      "exact_cohort_conditional_distributions_single_latent_cohort",
      "exact_rational_all_57_date_expectations",
      "fixed_prices_all_dates",
      "nonnegative_nonexpiring_inventory_coupling",
      earliest === 0 ? "exact_day0_tie" : "exact_previous_day_strict_lex_inequality",
      "range_only_no_global_or_deadline_claim",
    ],
  };
}
function unresolvedDateResult(
  reason: string,
  values: readonly ExactValue[],
  evaluatedDays: readonly number[],
): CertifiedWaiting {
  return {
    ...waitingBase("unresolved", reason),
    evaluatedDays,
    bestDayRange: [0, 56],
    successProbabilityInterval: { lower: toWire(values.at(-1)!.p), upper: toWire(ONE) },
    successImprovementUpperBound: toWire(sub(ONE, values.at(-1)!.p)),
    evidence: [
      "PH_lower_bound_from_last_exact_completed_date_and_nonnegative_inventory_coupling",
      "UNKNOWN_is_not_equality_or_false",
    ],
  };
}
export function exhaustiveDates(
  context: WaitingContext,
  events: readonly CertifiedSupplyEvent[],
): CertifiedWaiting {
  const caps = CAPS[context.sid]!.map((uses) => uses * 10) as [number, number, number];
  const initial = [0, 1, 2].map((k) => Math.min(context.input.stock[k]!, caps[k]!)) as [
    number,
    number,
    number,
  ];
  const supports = [
    singleton(initial, context.kernel.budget),
    singleton(initial, context.kernel.budget),
    singleton(initial, context.kernel.budget),
  ];
  const values: ExactValue[] = [context.current];
  const evaluatedDays = [0];
  try {
    for (let day = 1; day <= 56; day++) {
      context.kernel.budget.check();
      const arrivals = events.filter((event) => eventOffset(context.input, event) === day);
      advanceSupports(context, supports, arrivals, caps);
      const value = arrivals.length
        ? expectation(context.sid, supports, context.priors, context.kernel)
        : values[day - 1]!;
      if (compareValue(value, values[day - 1]!) < 0)
        throw new Error("certified_inventory_monotonicity_failed");
      values.push(value);
      evaluatedDays.push(day);
    }
    return exactDateResult(context, values, evaluatedDays);
  } catch (error) {
    if (!(error instanceof CertifiedLimit)) throw error;
    return unresolvedDateResult(error.reason, values, evaluatedDays);
  } finally {
    for (const support of supports) context.kernel.budget.release(support.bytes);
  }
}
