import type { Interval } from "../../shared/certifiedRational";
import type { BoundArena } from "./boundArena";
import type { WorkBudget } from "./budget";
import { consumptionBound, possibleActions, rationalBound, weightedBound } from "./directedBounds";
import { EDGES, minPositiveUses, TERMINAL, type Units } from "./game";
import {
  EMPTY_VECTOR,
  type GuidanceArithmetic,
  type Relaxation,
  type VectorRow,
} from "./guidanceArithmetic";
import { type GuidedState, guidedState } from "./guidanceDomain";
import type { PrimaryGuidance } from "./primaryGuidance";

const ZERO_BOUND: Interval = { lo: 0, hi: 0 };
export class CostGuidance {
  private readonly memo = new Map<number, VectorRow>();
  private readonly priceBounds: readonly Interval[];
  private readonly relaxedBounds: (Interval | undefined)[] = [];
  private readonly scale: bigint;
  constructor(
    private readonly budget: WorkBudget,
    private readonly arithmetic: GuidanceArithmetic,
    private readonly primary: PrimaryGuidance,
    private readonly arena: () => BoundArena,
    private readonly relaxed: (sid: number) => Relaxation,
  ) {
    // A common exact power-of-two scale makes all prices lie in [0,1]. It
    // preserves B comparisons even for thousands-bit custom rational prices.
    this.scale = 1n << BigInt(Math.max(...arithmetic.prices.map((p) => p.toString(2).length)));
    this.priceBounds = arithmetic.prices.map((n) => rationalBound({ n, d: this.scale }));
    budget.reserve(80 + Math.ceil(this.scale.toString(2).length / 8) + 3 * 16);
  }
  cached(sid: number, raw: Units): VectorRow | undefined {
    return this.memo.get(guidedState(sid, raw).key);
  }
  private supportsRelaxation(state: GuidedState, relaxation: Relaxation): boolean {
    return relaxation.bound.every((required, k) => state.units[k]! >= required);
  }
  private relaxedBound(sid: number, relaxation: Relaxation): Interval {
    const previous = this.relaxedBounds[sid];
    if (previous) return previous;
    const value = rationalBound({ n: relaxation.value.b.n, d: relaxation.value.b.d * this.scale });
    this.relaxedBounds[sid] = value;
    this.budget.reserve(16 + 8);
    return value;
  }
  private actionBound(sid: number, kit: number, units: Units): Interval {
    const [p, great, normal] = EDGES[sid]![kit]!;
    const remaining: Units = [...units];
    remaining[kit]!--;
    const children = weightedBound(
      p,
      p > 0 ? this.bound(great, remaining) : ZERO_BOUND,
      p < 1000 ? this.bound(normal, remaining) : ZERO_BOUND,
    );
    return consumptionBound(children, this.priceBounds[kit]!);
  }
  private actions(sid: number, state: GuidedState, mask: number): (Interval | null)[] {
    return [0, 1, 2].map((k) => (mask & (1 << k) ? this.actionBound(sid, k, state.units) : null));
  }
  private bound(sid: number, raw: Units): Interval {
    this.budget.tick();
    if (sid === TERMINAL) return ZERO_BOUND;
    const state = guidedState(sid, raw);
    if (state.units[0] + state.units[1] + state.units[2] < minPositiveUses(sid)) return ZERO_BOUND;
    const arena = this.arena();
    const cached = arena.get("cost", sid, state.units);
    if (cached) return cached;
    const relaxation = this.relaxed(sid);
    if (this.supportsRelaxation(state, relaxation)) return this.relaxedBound(sid, relaxation);
    const mask = this.primary.mask(sid, state);
    if (mask === 0) return ZERO_BOUND;
    const actions = this.actions(sid, state, mask).filter((a): a is Interval => a !== null);
    const value = {
      lo: Math.min(...actions.map((a) => a.lo)),
      hi: Math.min(...actions.map((a) => a.hi)),
    };
    arena.put("cost", sid, state.units, value);
    return value;
  }
  private action(sid: number, kit: number, units: Units, exponent: number): VectorRow {
    this.budget.exactTransitions++;
    const [p, great, normal] = EDGES[sid]![kit]!;
    const remaining: Units = [...units];
    remaining[kit]!--;
    const g = p > 0 ? this.get(great, remaining) : EMPTY_VECTOR;
    const n = p < 1000 ? this.get(normal, remaining) : EMPTY_VECTOR;
    return this.arithmetic.combine(p, g, n, exponent, kit);
  }
  private select(sid: number, state: GuidedState, candidates: number): VectorRow {
    let best: VectorRow | null = null;
    for (let kit = 0; kit < 3; kit++) {
      if (!(candidates & (1 << kit))) continue;
      const candidate = this.action(sid, kit, state.units, state.exponent);
      best = this.choose(best, candidate);
    }
    if (!best) throw new Error("certified_guidance_no_candidate");
    return best;
  }
  private choose(best: VectorRow | null, candidate: VectorRow): VectorRow {
    if (!best) return candidate;
    const comparison = this.arithmetic.compare(candidate, best);
    if (comparison > 0) return candidate;
    return comparison === 0 ? { ...best, mask: best.mask | candidate.mask } : best;
  }
  get(sid: number, raw: Units, enumerateRootActions = false): VectorRow {
    this.budget.tick();
    if (sid === TERMINAL) return EMPTY_VECTOR;
    const state = guidedState(sid, raw);
    if (state.units[0] + state.units[1] + state.units[2] < minPositiveUses(sid))
      return EMPTY_VECTOR;
    const previous = this.memo.get(state.key);
    if (previous) return previous;
    const relaxation = this.relaxed(sid);
    if (!enumerateRootActions && this.supportsRelaxation(state, relaxation))
      return this.arithmetic.fromRelaxed(relaxation.value, state.exponent);
    const mask = this.primary.mask(sid, state);
    if (mask === 0) return EMPTY_VECTOR;
    const candidates = possibleActions(this.actions(sid, state, mask));
    const value = this.select(sid, state, candidates);
    const limbs = value.consumed.reduce(
      (bytes, n) => bytes + Math.ceil(n.toString(2).length / 8),
      0,
    );
    this.budget.recordMemo(144 + limbs);
    this.memo.set(state.key, value);
    return value;
  }
}
