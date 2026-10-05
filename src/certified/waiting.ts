import { type Q, q, sub, toWire } from "../../shared/certifiedRational";
import { exhaustiveDates } from "./dateExpectations";
import { futureEvents, waitingBase } from "./events";
import type { FiniteKernel } from "./kernel";
import type { CertifiedInput, CertifiedValue, CertifiedWaiting } from "./types";
import { compareValue, type ExactValue } from "./value";
import type { WaitingContext } from "./waitingContext";
import { boundaryWitness } from "./witness";

const ONE = q(1);

function invariantResult(context: WaitingContext, evidence: readonly string[]): CertifiedWaiting {
  return {
    ...waitingBase("certified", null),
    recommendedDays: 0,
    bestDayRange: [0, 0],
    value: context.view(context.current),
    successProbabilityInterval: {
      lower: toWire(context.current.p),
      upper: toWire(context.current.p),
    },
    successImprovementUpperBound: toWire(sub(ONE, context.current.p)),
    evidence,
  };
}
export function solveWaiting(
  input: CertifiedInput,
  sid: number,
  current: ExactValue,
  kernel: FiniteKernel,
  priors: readonly [Q, Q, Q],
  view: (value: ExactValue) => CertifiedValue,
): CertifiedWaiting {
  const context: WaitingContext = { input, sid, current, kernel, priors, view };
  const events = futureEvents(input);
  // Equality in all three exact components proves stock-value invariance even
  // when future coverage is incomplete or positive arrivals exist.
  if (compareValue(current, kernel.unlimited(sid).value) === 0) {
    return invariantResult(context, [
      "exact_P_B_C_equal_feasible_unlimited_optimum",
      "fixed_prices_all_dates",
      "nonnegative_nonexpiring_inventory_coupling",
      "range_only_no_deadline",
    ]);
  }
  if (!input.snapshot.coverage.future.complete)
    return { ...waitingBase("unresolved", "future_coverage_incomplete"), bestDayRange: [0, 56] };
  if (events.every((event) => event.refs.every((ref) => ref.count === 0))) {
    return invariantResult(context, [
      "no_random_and_no_deterministic_arrivals_in_complete_future_snapshot",
      "exact_all_dates_same_inventory",
    ]);
  }
  // A witness is falsifiable exact support evidence; a failed search proves no equality.
  return boundaryWitness(context, events) ?? exhaustiveDates(context, events);
}
