import type { CertifiedSupplyEvent } from "../../shared/certifiedSupply";
import type { ExactSupplyOutcome } from "../../shared/certifiedSupplyLaws";
import { law } from "./events";
import { compareValue, type ExactValue } from "./value";
import type { WaitingContext } from "./waitingContext";
import {
  appendReceipt,
  type Cohort,
  releaseTrajectory,
  type Trajectory,
  trajectory,
} from "./witnessTrajectory";

type Entry = { event: CertifiedSupplyEvent; index: number; min: number; max: number };
type WitnessPair = {
  cohort: Cohort;
  before: Trajectory;
  after: Trajectory;
  beforeValue: ExactValue;
  afterValue: ExactValue;
};
const ENTRY_BYTES = 64;
function colorRange(
  outcomes: readonly ExactSupplyOutcome[],
  color: number,
): readonly [number, number] {
  let min = Infinity,
    max = -Infinity;
  for (const outcome of outcomes) {
    if (outcome.mass.n <= 0n) continue;
    min = Math.min(min, outcome.pieces[color]!);
    max = Math.max(max, outcome.pieces[color]!);
  }
  if (!Number.isFinite(min)) throw new Error("certified_empty_positive_law");
  return [min, max];
}
function entriesFor(
  context: WaitingContext,
  events: readonly CertifiedSupplyEvent[],
  cohort: Cohort,
  color: number,
): Entry[] {
  const entries: Entry[] = [];
  for (const event of events) {
    for (let index = 0; index < event.refs.length; index++) {
      const [min, max] = colorRange(
        law(context.input, event, index, cohort, context.kernel.budget),
        color,
      );
      context.kernel.budget.reserve(ENTRY_BYTES);
      entries.push({ event, index, min, max });
    }
  }
  return entries;
}
function selectedInRange(
  outcomes: readonly ExactSupplyOutcome[],
  color: number,
  minimum: number,
  maximum: number,
  otherColors: readonly number[] = [],
): ExactSupplyOutcome | null {
  let chosen: ExactSupplyOutcome | null = null;
  for (const outcome of outcomes) {
    if (
      outcome.mass.n <= 0n ||
      outcome.pieces[color]! < minimum ||
      outcome.pieces[color]! > maximum
    )
      continue;
    if (
      !chosen ||
      outcome.pieces[color]! > chosen.pieces[color]! ||
      (outcome.pieces[color] === chosen.pieces[color] &&
        otherSupply(outcome, otherColors) > otherSupply(chosen, otherColors))
    )
      chosen = outcome;
  }
  return chosen;
}
function otherSupply(outcome: ExactSupplyOutcome, colors: readonly number[]): number {
  return colors.reduce((total, color) => total + outcome.pieces[color]!, 0);
}
function suffixRange(entries: readonly Entry[], needed: number): { min: number[]; max: number[] } {
  const min = Array<number>(entries.length + 1).fill(0),
    max = Array<number>(entries.length + 1).fill(0);
  for (let i = entries.length - 1; i >= 0; i--) {
    min[i] = Math.min(needed + 1, min[i + 1]! + entries[i]!.min);
    max[i] = Math.min(needed + 1, max[i + 1]! + entries[i]!.max);
  }
  return { min, max };
}
function targetTrajectory(
  context: WaitingContext,
  events: readonly CertifiedSupplyEvent[],
  cohort: Cohort,
  color: number,
  target: number,
  otherColors: readonly number[],
): Trajectory | null {
  const needed = target - context.input.stock[color]!;
  if (needed < 0) return null;
  const entries = entriesFor(context, events, cohort, color);
  const path: Trajectory = { stock: context.input.stock, receipts: [], bytes: 0 };
  let retained = false;
  const rangeBytes = (entries.length + 1) * 16;
  try {
    context.kernel.budget.reserve(rangeBytes);
    const range = suffixRange(entries, needed);
    if (needed < range.min[0]! || needed > range.max[0]!) return null;
    let remaining = needed;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const selected = selectedInRange(
        law(context.input, entry.event, entry.index, cohort, context.kernel.budget),
        color,
        remaining - range.max[i + 1]!,
        remaining - range.min[i + 1]!,
        otherColors,
      );
      if (!selected) return null;
      appendReceipt(context, path, entry.event, entry.index, selected);
      remaining -= selected.pieces[color]!;
    }
    if (remaining !== 0) return null;
    retained = true;
    return path;
  } finally {
    context.kernel.budget.release(entries.length * ENTRY_BYTES + rangeBytes);
    if (!retained) releaseTrajectory(context, path);
  }
}
function maximalOutcome(
  outcomes: readonly ExactSupplyOutcome[],
  color: number,
): ExactSupplyOutcome {
  const selected = selectedInRange(outcomes, color, 0, Infinity);
  if (!selected) throw new Error("certified_empty_positive_law");
  return selected;
}
function exactPair(
  context: WaitingContext,
  last: readonly CertifiedSupplyEvent[],
  cohort: Cohort,
  color: number,
  before: Trajectory,
): WitnessPair | null {
  const after = trajectory(context, last, cohort, before.stock, (_event, _index, outcomes) =>
    maximalOutcome(outcomes, color),
  );
  let retained = false;
  try {
    const beforeValue = context.kernel.solve(context.sid, before.stock);
    const afterValue = context.kernel.solve(context.sid, after.stock);
    if (compareValue(afterValue, beforeValue) <= 0) return null;
    retained = true;
    return { cohort, before, after, beforeValue, afterValue };
  } finally {
    if (!retained) {
      releaseTrajectory(context, before);
      releaseTrajectory(context, after);
    }
  }
}
/** Search genuine receipt paths one use below each nonzero unlimited policy bound.
 * Mixed policies first try the smallest additional target-color stock, and
 * equal target-color gains prefer the other policy colors.
 * This changes only the selector; a monochromatic policy keeps its old ordering.
 * Greedy reachability is only a selector: gaps or no strict exact P/B/C change
 * return UNKNOWN to the existing witness/exhaustive fallback. No value follows
 * from proximity to the bound; both finite endpoint values are evaluated.
 */
export function nearBoundWitness(
  context: WaitingContext,
  prior: readonly CertifiedSupplyEvent[],
  last: readonly CertifiedSupplyEvent[],
): WitnessPair | null {
  const bound = context.kernel.unlimited(context.sid).bound;
  const colors = [0, 1, 2].filter((color) => bound[color]! > 0);
  if (colors.length > 1)
    colors.sort(
      (a, b) =>
        bound[a]! * 10 - context.input.stock[a]! - (bound[b]! * 10 - context.input.stock[b]!),
    );
  for (const color of colors) {
    const otherColors = colors.filter((other) => other !== color);
    const target = bound[color]! * 10 - 10;
    for (const cohort of [0, 1, 2] as const) {
      if (context.priors[cohort].n === 0n) continue;
      const before = targetTrajectory(context, prior, cohort, color, target, otherColors);
      if (!before) continue;
      const pair = exactPair(context, last, cohort, color, before);
      if (pair) return pair;
    }
  }
  return null;
}
