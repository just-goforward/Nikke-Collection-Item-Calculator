import { type Interval, type Q, qInterval } from "../../shared/certifiedRational";

export const UNKNOWN_BOUND: Interval = { lo: 0, hi: Infinity };
const scratch = new DataView(new ArrayBuffer(8));

function valid(a: Interval): boolean {
  return Number.isFinite(a.lo) && Number.isFinite(a.hi) && a.lo >= 0 && a.hi >= a.lo;
}

/** Positive binary64 neighbours; unsupported inputs deliberately widen bounds. */
export function positiveUp(x: number): number {
  if (!Number.isFinite(x) || x < 0) return Infinity;
  if (x === 0) return Number.MIN_VALUE;
  scratch.setFloat64(0, x);
  const low = (scratch.getUint32(4) + 1) >>> 0;
  const high = scratch.getUint32(0) + (low === 0 ? 1 : 0);
  scratch.setUint32(4, low);
  scratch.setUint32(0, high);
  return scratch.getFloat64(0);
}

export function positiveDown(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  scratch.setFloat64(0, x);
  const previousLow = scratch.getUint32(4);
  scratch.setUint32(4, (previousLow - 1) >>> 0);
  scratch.setUint32(0, scratch.getUint32(0) - (previousLow === 0 ? 1 : 0));
  return scratch.getFloat64(0);
}

function weightedTerm(x: number, mass: number, upper: boolean): number {
  if (x === 0 || mass === 0) return 0;
  const round = upper ? positiveUp : positiveDown;
  return round(round(x * mass) / 1000);
}

/** Each multiply, divide and add is enclosed separately; there is no clipping. */
export function weightedBound(perMille: number, great: Interval, normal: Interval): Interval {
  if (!Number.isInteger(perMille) || perMille < 0 || perMille > 1000) return UNKNOWN_BOUND;
  if (!valid(great) || !valid(normal)) return UNKNOWN_BOUND;
  if (perMille === 0) return normal;
  if (perMille === 1000) return great;
  const lo = positiveDown(
    weightedTerm(great.lo, perMille, false) + weightedTerm(normal.lo, 1000 - perMille, false),
  );
  const hi = positiveUp(
    weightedTerm(great.hi, perMille, true) + weightedTerm(normal.hi, 1000 - perMille, true),
  );
  return Number.isFinite(hi) ? { lo, hi } : UNKNOWN_BOUND;
}

export function consumptionBound(child: Interval, price: Interval): Interval {
  if (!valid(child) || !valid(price)) return UNKNOWN_BOUND;
  const lo = positiveDown(child.lo + positiveDown(10 * price.lo));
  const hi = positiveUp(child.hi + positiveUp(10 * price.hi));
  return Number.isFinite(hi) ? { lo, hi } : UNKNOWN_BOUND;
}

export function rationalBound(value: Q): Interval {
  try {
    const result = qInterval(value);
    return valid(result) ? result : UNKNOWN_BOUND;
  } catch {
    return UNKNOWN_BOUND;
  }
}

/** A cast to Float32 can only widen the stored upper endpoint. */
export function outwardWidth(lo: number, hi: number): number | null {
  if (!valid({ lo, hi })) return null;
  const width = positiveUp(hi - lo);
  let packed = Math.fround(width);
  if (packed < width) {
    scratch.setFloat32(0, packed);
    scratch.setUint32(0, scratch.getUint32(0) + 1);
    packed = scratch.getFloat32(0);
  }
  return Number.isFinite(packed) ? packed : null;
}

export function possibleActions(actions: readonly (Interval | null)[]): number {
  const enclosed = actions.map((action) => action && (valid(action) ? action : UNKNOWN_BOUND));
  const upper = Math.min(...enclosed.map((a) => a?.hi ?? Infinity));
  return enclosed.reduce((mask, action, kit) => {
    if (!action) return mask;
    return action.lo <= upper ? mask | (1 << kit) : mask;
  }, 0);
}
