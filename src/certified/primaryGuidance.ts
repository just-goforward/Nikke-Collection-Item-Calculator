import type { Interval } from "../../shared/certifiedRational";
import type { BoundArena } from "./boundArena";
import type { WorkBudget } from "./budget";
import { CertainCompletion } from "./completion";
import { possibleActions, weightedBound } from "./directedBounds";
import {
  assertPositiveGreatProbabilities,
  EDGES,
  minPositiveUses,
  TERMINAL,
  type Units,
} from "./game";
import { EMPTY_PRIMARY, type GuidanceArithmetic, type PrimaryRow } from "./guidanceArithmetic";
import { type GuidedState, guidedState } from "./guidanceDomain";

const ZERO_BOUND: Interval = { lo: 0, hi: 0 };
const ONE_BOUND: Interval = { lo: 1, hi: 1 };

/** Failure intervals only select provably possible P-optimal actions. Every
 * unresolved comparison is recomputed with integer probability numerators. */
export class PrimaryGuidance {
  private readonly memo = new Map<number, PrimaryRow>();
  readonly completion: CertainCompletion;
  constructor(
    private readonly budget: WorkBudget,
    private readonly arithmetic: GuidanceArithmetic,
    private readonly arena: () => BoundArena,
  ) {
    assertPositiveGreatProbabilities();
    this.completion = new CertainCompletion(budget);
  }
  has(sid: number, units: Units): boolean {
    return this.completion.has(sid, units) || this.memo.has(guidedState(sid, units).key);
  }
  private failed(sid: number, units: Units): boolean {
    return units[0] + units[1] + units[2] < minPositiveUses(sid);
  }
  private failureAction(sid: number, kit: number, units: Units): Interval {
    const [p, great, normal] = EDGES[sid]![kit]!;
    const remaining: Units = [...units];
    remaining[kit]!--;
    return weightedBound(
      p,
      p > 0 ? this.failure(great, remaining) : ZERO_BOUND,
      p < 1000 ? this.failure(normal, remaining) : ZERO_BOUND,
    );
  }
  private failure(sid: number, raw: Units): Interval {
    this.budget.tick();
    if (sid === TERMINAL) return ZERO_BOUND;
    const { units } = guidedState(sid, raw);
    if (this.failed(sid, units)) return ONE_BOUND;
    if (this.completion.has(sid, units)) return ZERO_BOUND;
    const arena = this.arena();
    const cached = arena.get("failure", sid, units);
    if (cached) return cached;
    const actions = this.failureActions(sid, units).filter((a): a is Interval => a !== null);
    const value = {
      lo: Math.min(...actions.map((a) => a.lo)),
      hi: Math.min(...actions.map((a) => a.hi)),
    };
    arena.put("failure", sid, units, value);
    return value;
  }
  private failureActions(sid: number, units: Units): (Interval | null)[] {
    return [0, 1, 2].map((k) => (units[k]! > 0 ? this.failureAction(sid, k, units) : null));
  }
  mask(sid: number, state: GuidedState): number {
    if (this.failed(sid, state.units)) return 0;
    if (this.completion.has(sid, state.units)) return this.completion.mask(sid, state.units);
    const candidates = possibleActions(this.failureActions(sid, state.units));
    // The asserted positive-great model makes each feasible action P>0 here.
    // A uniquely retained action therefore strictly beats STOP's P=0.
    if ((candidates & (candidates - 1)) === 0) return candidates;
    return this.get(sid, state.units).mask;
  }
  private action(sid: number, kit: number, units: Units, exponent: number): bigint {
    this.budget.exactTransitions++;
    const [p, great, normal] = EDGES[sid]![kit]!;
    const remaining: Units = [...units];
    remaining[kit]!--;
    const g = p > 0 ? this.get(great, remaining) : EMPTY_PRIMARY;
    const n = p < 1000 ? this.get(normal, remaining) : EMPTY_PRIMARY;
    const gm = p > 0 ? BigInt(p) * this.arithmetic.power(exponent - 1 - g.exponent) : 0n;
    const nm = p < 1000 ? BigInt(1000 - p) * this.arithmetic.power(exponent - 1 - n.exponent) : 0n;
    return gm * g.p + nm * n.p;
  }
  private select(sid: number, state: GuidedState, candidates: number): PrimaryRow {
    let p = 0n,
      mask = 0;
    for (let kit = 0; kit < 3; kit++) {
      if (!(candidates & (1 << kit))) continue;
      const candidate = this.action(sid, kit, state.units, state.exponent);
      if (candidate > p) {
        p = candidate;
        mask = 1 << kit;
      } else if (candidate === p && p > 0n) mask |= 1 << kit;
    }
    return { p, mask, exponent: state.exponent };
  }
  get(sid: number, raw: Units): PrimaryRow {
    this.budget.tick();
    if (sid === TERMINAL) return { p: 1n, exponent: 0, mask: 0 };
    const state = guidedState(sid, raw);
    if (this.failed(sid, state.units)) return EMPTY_PRIMARY;
    if (this.completion.has(sid, state.units))
      return { p: 1n, exponent: 0, mask: this.completion.mask(sid, state.units) };
    const previous = this.memo.get(state.key);
    if (previous) return previous;
    const candidates = possibleActions(this.failureActions(sid, state.units));
    const value = this.select(sid, state, candidates);
    this.budget.recordMemo(80 + Math.ceil(value.p.toString(2).length / 8));
    this.memo.set(state.key, value);
    return value;
  }
}
