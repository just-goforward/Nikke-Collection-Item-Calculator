import { q, sub, toWire } from "../../shared/certifiedRational";
import type { CertifiedSupplyEvent } from "../../shared/certifiedSupply";
import type { ExactSupplyOutcome } from "../../shared/certifiedSupplyLaws";
import { eventOffset, law, waitingBase } from "./events";
import { KIT_INDICES, type KitIndex } from "./game";
import { nearBoundWitness } from "./nearBoundWitness";
import type { CertifiedWaiting } from "./types";
import { compareValue, type ExactValue } from "./value";
import type { WaitingContext } from "./waitingContext";
import { type Cohort, releaseTrajectory, type Trajectory, trajectory } from "./witnessTrajectory";

const ONE = q(1);
type FinalCandidate = {
  event: CertifiedSupplyEvent;
  refIndex: number;
  outcome: ExactSupplyOutcome;
};
function scarceOutcome(
  outcomes: readonly ExactSupplyOutcome[],
  scarce: KitIndex,
): ExactSupplyOutcome {
  let chosen: ExactSupplyOutcome | undefined;
  for (const outcome of outcomes) {
    if (outcome.mass.n <= 0n) continue;
    if (
      !chosen ||
      outcome.pieces[scarce] < chosen.pieces[scarce] ||
      (outcome.pieces[scarce] === chosen.pieces[scarce] &&
        outcome.pieces.reduce((a, b) => a + b, 0) < chosen.pieces.reduce((a, b) => a + b, 0))
    )
      chosen = outcome;
  }
  if (!chosen) throw new Error("certified_empty_positive_law");
  return chosen;
}
function* finalCandidates(
  context: WaitingContext,
  events: readonly CertifiedSupplyEvent[],
  cohort: Cohort,
): Generator<FinalCandidate> {
  for (const event of events) {
    for (let refIndex = 0; refIndex < event.refs.length; refIndex++) {
      for (const outcome of law(context.input, event, refIndex, cohort, context.kernel.budget)) {
        if (outcome.mass.n > 0n) yield { event, refIndex, outcome };
      }
    }
  }
}
function finalOutcome(
  candidate: FinalCandidate,
  event: CertifiedSupplyEvent,
  refIndex: number,
  outcomes: readonly ExactSupplyOutcome[],
): ExactSupplyOutcome {
  const selected =
    event === candidate.event && refIndex === candidate.refIndex
      ? candidate.outcome
      : outcomes.find((outcome) => outcome.mass.n > 0n);
  if (!selected) throw new Error("certified_empty_positive_law");
  return selected;
}
function boundaryResult(
  context: WaitingContext,
  cohort: Cohort,
  before: Trajectory,
  after: Trajectory,
  beforeValue: ExactValue,
  afterValue: ExactValue,
): CertifiedWaiting {
  return {
    ...waitingBase("certified", null),
    recommendedDays: 56,
    rangeBoundary: true,
    bestDayRange: [56, 56],
    evaluatedDays: [0],
    value: null,
    successProbabilityInterval: { lower: toWire(context.current.p), upper: toWire(ONE) },
    successImprovementUpperBound: toWire(sub(ONE, context.current.p)),
    evidence: [
      "fixed_prices_all_dates",
      "nonnegative_nonexpiring_inventory_coupling",
      "single_latent_cohort_positive_prior",
      "positive_mass_receipt_witness_strict_lex_day55_to56",
      "all_prior_dates_bounded_by_day55",
      "PH_lower_bound_from_exact_current_P_and_inventory_coupling",
      "range_only_no_global_or_deadline_claim",
    ],
    strictBoundaryWitness: {
      cohort,
      receipts: [...before.receipts, ...after.receipts],
      beforeStock: before.stock,
      afterStock: after.stock,
      beforeValue: context.view(beforeValue),
      afterValue: context.view(afterValue),
    },
  };
}
/**
 * Nonnegative, nonexpiring arrivals and fixed prices give pointwise lex
 * monotonicity. In a finite positive-mass mixture, a strict witness implies
 * strict expectation at the first globally changing objective component.
 * Thus a strict day55->56 witness proves earliest range maximum=56.
 * Failure of these deterministic selectors is UNKNOWN, never equality.
 */
export function boundaryWitness(
  context: WaitingContext,
  events: readonly CertifiedSupplyEvent[],
): CertifiedWaiting | null {
  const last = events.filter((event) => eventOffset(context.input, event) === 56);
  if (last.length === 0) return null;
  const prior = events.filter((event) => eventOffset(context.input, event) !== 56);
  const near = nearBoundWitness(context, prior, last);
  if (near)
    return boundaryResult(
      context,
      near.cohort,
      near.before,
      near.after,
      near.beforeValue,
      near.afterValue,
    );
  for (const cohort of [0, 1, 2] as const) {
    if (context.priors[cohort].n === 0n) continue;
    for (const scarce of KIT_INDICES) {
      const before = trajectory(
        context,
        prior,
        cohort,
        context.input.stock,
        (_event, _index, outcomes) => scarceOutcome(outcomes, scarce),
      );
      const beforeValue = context.kernel.solve(context.sid, before.stock);
      for (const candidate of finalCandidates(context, last, cohort)) {
        context.kernel.budget.tick();
        const after = trajectory(context, last, cohort, before.stock, (event, index, outcomes) =>
          finalOutcome(candidate, event, index, outcomes),
        );
        const afterValue = context.kernel.solve(context.sid, after.stock);
        if (compareValue(afterValue, beforeValue) > 0)
          return boundaryResult(context, cohort, before, after, beforeValue, afterValue);
        releaseTrajectory(context, after);
      }
      releaseTrajectory(context, before);
    }
  }
  return null;
}
