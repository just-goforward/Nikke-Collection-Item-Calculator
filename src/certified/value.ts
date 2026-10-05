import { cmp, type Q, q } from "../../shared/certifiedRational";
import { rationalPayload } from "./budget";

const ZERO = q(0);
const ONE = q(1);
export interface ExactValue {
  p: Q;
  /** Internal B multiplied by the kernel's positive burdenScale; actualValue restores public B. */
  b: Q;
  c: Q;
  consumed: readonly [Q, Q, Q];
  mask: number;
}
export const FAILED: ExactValue = {
  p: ZERO,
  b: ZERO,
  c: ZERO,
  consumed: [ZERO, ZERO, ZERO],
  mask: 0,
};
export const COMPLETE: ExactValue = { ...FAILED, p: ONE };

/** Same fixed-price kernel only. Positive means a is better; no epsilon or overlapping-interval tie. */
export function compareValue(a: ExactValue, b: ExactValue): -1 | 0 | 1 {
  const p = cmp(a.p, b.p);
  if (p) return p;
  const burden = cmp(b.b, a.b);
  return burden || cmp(b.c, a.c);
}

export function valuePayload(v: ExactValue): number {
  return 80 + [v.p, v.b, v.c, ...v.consumed].reduce((bytes, a) => bytes + rationalPayload(a), 0);
}
