import { type Q, q } from "../../shared/certifiedRational";
import type { WorkBudget } from "./budget";
import { KIT_INDICES, type KitIndex } from "./game";
import type { ExactValue } from "./value";

export type PrimaryRow = { p: bigint; exponent: number; mask: number };
export type VectorRow = {
  consumed: readonly [bigint, bigint, bigint];
  exponent: number;
  mask: number;
};
export type Relaxation = {
  value: ExactValue;
  bound: readonly number[];
  actions: readonly ExactValue[];
};
export const EMPTY_VECTOR: VectorRow = { consumed: [0n, 0n, 0n], exponent: 0, mask: 0 };
export const EMPTY_PRIMARY: PrimaryRow = { p: 0n, exponent: 0, mask: 0 };

/** D=1000^min(sum capped uses,max positive path length). Every child exponent
 * is <=parent-1 by both bounds, so all lift exponents are nonnegative. */
export class GuidanceArithmetic {
  private readonly powers: bigint[] = [1n];
  constructor(
    readonly prices: readonly [bigint, bigint, bigint],
    private readonly budget: WorkBudget,
  ) {}
  power(exponent: number): bigint {
    if (!Number.isInteger(exponent) || exponent < 0) throw new Error("certified_guidance_lift");
    while (this.powers.length <= exponent) {
      const previous = this.powers.at(-1)!;
      const next = previous * 1000n;
      this.powers.push(next);
      this.budget.reserve(24 + Math.ceil(next.toString(2).length / 8));
    }
    return this.powers[exponent]!;
  }
  burden(value: VectorRow): bigint {
    return KIT_INDICES.reduce((total, k) => total + value.consumed[k] * this.prices[k], 0n);
  }
  total(value: VectorRow): bigint {
    return value.consumed[0] + value.consumed[1] + value.consumed[2];
  }
  compare(a: VectorRow, b: VectorRow): -1 | 0 | 1 {
    const ab = this.burden(a),
      bb = this.burden(b);
    if (ab !== bb) return ab < bb ? 1 : -1;
    const ac = this.total(a),
      bc = this.total(b);
    if (ac === bc) return 0;
    return ac < bc ? 1 : -1;
  }
  combine(
    perMille: number,
    great: VectorRow,
    normal: VectorRow,
    exponent: number,
    kit: number,
  ): VectorRow {
    const gm = perMille ? BigInt(perMille) * this.power(exponent - 1 - great.exponent) : 0n;
    const nm =
      perMille < 1000 ? BigInt(1000 - perMille) * this.power(exponent - 1 - normal.exponent) : 0n;
    const immediate = 10n * this.power(exponent);
    const consumption = (k: KitIndex): bigint =>
      gm * great.consumed[k] + nm * normal.consumed[k] + (kit === k ? immediate : 0n);
    return {
      consumed: [consumption(0), consumption(1), consumption(2)],
      exponent,
      mask: 1 << kit,
    };
  }
  fromRelaxed(value: ExactValue, exponent: number): VectorRow {
    const denominator = this.power(exponent);
    const lift = (v: Q): bigint => {
      if (denominator % v.d !== 0n) throw new Error("certified_guidance_relaxed_denominator");
      return v.n * (denominator / v.d);
    };
    return {
      consumed: value.consumed.map(lift) as [bigint, bigint, bigint],
      exponent,
      mask: value.mask,
    };
  }
  view(primary: PrimaryRow, vector: VectorRow): ExactValue {
    const denominator = this.power(vector.exponent);
    return {
      p: q(primary.p, this.power(primary.exponent)),
      b: q(this.burden(vector), denominator),
      c: q(this.total(vector), denominator),
      consumed: vector.consumed.map((n) => q(n, denominator)) as [Q, Q, Q],
      mask: vector.mask,
    };
  }
}
