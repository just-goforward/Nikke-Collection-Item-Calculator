import { cmp, type Q, q } from "../../shared/certifiedRational";
import type { WorkBudget } from "./budget";
import {
  CAPS,
  EDGES,
  KIT_INDICES,
  type KitIndex,
  minPositiveUses,
  type StateId,
  TERMINAL,
  type Units,
} from "./game";
import { GUIDE_DIMENSIONS } from "./guidanceDomain";
import type { Triple } from "./types";
import type { ExactValue } from "./value";

type IntegerValue = {
  p: bigint;
  consumed: readonly [bigint, bigint, bigint];
  exponent: number;
  mask: number;
};
type Relaxation = { value: ExactValue; bound: Units; actions: readonly ExactValue[] };
const FAILED: IntegerValue = { p: 0n, consumed: [0n, 0n, 0n], exponent: 0, mask: 0 };
const COMPLETE: IntegerValue = { ...FAILED, p: 1n };
const Y_STRIDE = GUIDE_DIMENSIONS[2];
const B_STRIDE = GUIDE_DIMENSIONS[1] * Y_STRIDE;
const STATE_STRIDE = GUIDE_DIMENSIONS[0] * B_STRIDE;
const INTEGER_MEMO_MAX_KEY = TERMINAL * STATE_STRIDE - 1;
if (!Number.isSafeInteger(INTEGER_MEMO_MAX_KEY) || INTEGER_MEMO_MAX_KEY > Number.MAX_SAFE_INTEGER) {
  throw new Error("certified_integer_memo_key_domain_not_exact");
}
// Mixed-radix encoding is injective: every capped stock digit is strictly less
// than its radix, sid<600, and the greatest key is below 2^53. Raw stock is
// validated integral, divided into integral uses, then capped before encoding.

/**
 * D(u)=1000^(sum u). All path probabilities divide this common denominator.
 * If child c has a lower exponent after exact stock caps, its action term is
 * p_k*N(c)*1000^(U-1-Uc). Immediate consumption is 10*1000^U.
 * Four integer numerators suffice: P and three expected piece components.
 * B and C are exact linear combinations; no rational reduction happens in DP.
 */
export class IntegerFiniteTable {
  private readonly memo = new Map<number, IntegerValue>();
  private readonly powers: bigint[] = [1n];
  constructor(
    private readonly prices: readonly [bigint, bigint, bigint],
    private readonly budget: WorkBudget,
    private readonly relaxed: (sid: number) => Relaxation,
  ) {}

  private power(exponent: number): bigint {
    while (this.powers.length <= exponent) {
      const previous = this.powers.at(-1)!;
      const next = previous * 1000n;
      this.powers.push(next);
      this.budget.reserve(24 + Math.ceil(next.toString(2).length / 8));
    }
    return this.powers[exponent]!;
  }
  private fromRelaxed(value: ExactValue, exponent: number): IntegerValue {
    const denominator = this.power(exponent);
    const lift = (value: Q): bigint => {
      if (denominator % value.d !== 0n) throw new Error("certified_integer_denominator_invariant");
      return value.n * (denominator / value.d);
    };
    return {
      p: lift(value.p),
      consumed: value.consumed.map(lift) as [bigint, bigint, bigint],
      exponent,
      mask: value.mask,
    };
  }
  private burden(value: IntegerValue): bigint {
    return (
      value.consumed[0] * this.prices[0] +
      value.consumed[1] * this.prices[1] +
      value.consumed[2] * this.prices[2]
    );
  }
  private total(value: IntegerValue): bigint {
    return value.consumed[0] + value.consumed[1] + value.consumed[2];
  }
  private compare(a: IntegerValue, b: IntegerValue): -1 | 0 | 1 {
    // Both candidates at a state have the identical exponent. STOP is zero,
    // so the exponent-free singleton also compares directly at every state.
    if (a.p !== b.p) return a.p > b.p ? 1 : -1;
    const ab = this.burden(a),
      bb = this.burden(b);
    if (ab !== bb) return ab < bb ? 1 : -1;
    const ac = this.total(a),
      bc = this.total(b);
    if (ac === bc) return 0;
    return ac < bc ? 1 : -1;
  }

  private action(sid: number, kit: KitIndex, units: Units, exponent: number): IntegerValue {
    this.budget.tick();
    this.budget.exactTransitions++;
    const [perMille, great, normal] = EDGES[sid as StateId][kit];
    const remaining: Units = [...units];
    remaining[kit]--;
    const g = perMille ? this.get(great, remaining) : FAILED;
    const n = perMille < 1000 ? this.get(normal, remaining) : FAILED;
    const gm = perMille ? BigInt(perMille) * this.power(exponent - 1 - g.exponent) : 0n;
    const nm =
      perMille < 1000 ? BigInt(1000 - perMille) * this.power(exponent - 1 - n.exponent) : 0n;
    const immediate = 10n * this.power(exponent);
    const consumption = (k: KitIndex): bigint =>
      gm * g.consumed[k] + nm * n.consumed[k] + (kit === k ? immediate : 0n);
    return {
      p: gm * g.p + nm * n.p,
      exponent,
      mask: 1 << kit,
      consumed: [consumption(0), consumption(1), consumption(2)],
    };
  }

  private dominatedByRelaxation(best: IntegerValue, bound: ExactValue, exponent: number): boolean {
    const denominator = this.power(exponent);
    if (best.p !== denominator) return false;
    const bDifference = bound.b.n * denominator - this.burden(best) * bound.b.d;
    return (
      bDifference > 0n ||
      (bDifference === 0n && bound.c.n * denominator > this.total(best) * bound.c.d)
    );
  }

  private selectActions(
    sid: number,
    units: Units,
    exponent: number,
    relaxation: Relaxation,
  ): IntegerValue {
    // selectActions is reached only for sid<600; unlimited(sid) has filled
    // all three action slots before returning its relaxation.
    const actions = relaxation.actions as readonly [ExactValue, ExactValue, ExactValue];
    const order = [...KIT_INDICES].sort(
      (a, b) => cmp(actions[a].b, actions[b].b) || cmp(actions[a].c, actions[b].c) || a - b,
    );
    let best = FAILED,
      chosen = -1;
    for (const kit of order) {
      if (units[kit] === 0) continue;
      if (this.dominatedByRelaxation(best, actions[kit], exponent)) continue;
      const action = this.action(sid, kit, units, exponent);
      const comparison = this.compare(action, best);
      if (comparison > 0) {
        best = action;
        chosen = kit;
      } else if (comparison === 0) {
        const mask = best.mask | action.mask;
        if (chosen < 0 || kit < chosen) {
          best = { ...action, mask };
          chosen = kit;
        } else best = { ...best, mask };
      }
    }
    return best;
  }

  private get(sid: number, rawUnits: Triple, enumerateRootActions = false): IntegerValue {
    this.budget.tick();
    if (sid === TERMINAL) return COMPLETE;
    const caps = CAPS[sid as StateId];
    const units: Units = [
      Math.min(rawUnits[0], caps[0]),
      Math.min(rawUnits[1], caps[1]),
      Math.min(rawUnits[2], caps[2]),
    ];
    const exponent = units[0] + units[1] + units[2];
    if (exponent < minPositiveUses(sid)) return FAILED;
    const key = sid * STATE_STRIDE + units[0] * B_STRIDE + units[1] * Y_STRIDE + units[2];
    const previous = this.memo.get(key);
    if (previous) return previous;
    const relaxation = this.relaxed(sid);
    if (!enumerateRootActions && KIT_INDICES.every((k) => units[k] >= relaxation.bound[k])) {
      return this.fromRelaxed(relaxation.value, exponent);
    }
    const best = this.selectActions(sid, units, exponent, relaxation);
    const bytes =
      160 +
      [best.p, ...best.consumed].reduce(
        (size, value) => size + Math.ceil(value.toString(2).length / 8),
        0,
      );
    this.budget.recordMemo(bytes);
    this.memo.set(key, best);
    return best;
  }

  value(sid: number, units: Triple, enumerateRootActions = false): ExactValue {
    const value = this.get(sid, units, enumerateRootActions);
    const denominator = this.power(value.exponent);
    return {
      p: q(value.p, denominator),
      b: q(this.burden(value), denominator),
      c: q(this.total(value), denominator),
      consumed: value.consumed.map((pieces) => q(pieces, denominator)) as [Q, Q, Q],
      mask: value.mask,
    };
  }
}
