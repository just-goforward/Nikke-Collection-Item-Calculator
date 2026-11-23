import { cmp, fromBinary64, toNumber, type Q } from '../../shared/certifiedRational.ts';
import type { Bound } from './types.ts';

// A shared scalar scratch, not an allocation per DP edge. Handle either host
// endianness; no BigInt is needed for an adjacent binary64 in the hot loop.
const bits = new ArrayBuffer(8);
const floats = new Float64Array(bits);
const words = new Uint32Array(bits);
floats[0] = 1;
const high = words[0] === 0 ? 1 : 0;
const low = 1 - high;

export function up(value: number): number {
  if (value === Infinity || Number.isNaN(value)) return value;
  if (value === 0) return Number.MIN_VALUE;
  floats[0] = value;
  if (value > 0) {
    if (words[low] === 0xffff_ffff) {
      words[low] = 0;
      words[high] = words[high]! + 1;
    } else words[low] = words[low]! + 1;
  } else if (words[low] === 0) {
    words[low] = 0xffff_ffff;
    words[high] = words[high]! - 1;
  } else words[low] = words[low]! - 1;
  return floats[0]!;
}

export function down(value: number): number {
  return -up(-value);
}

/** Correctly rounded conversion and exact direction, including subnormals. */
export function rationalBound(value: Q): Bound {
  const estimate = toNumber(value);
  if (!Number.isFinite(estimate)) throw new RangeError('approx_nonfinite_rational');
  const order = cmp(fromBinary64(estimate), value);
  return {
    estimate,
    lower: order > 0 ? down(estimate) : estimate,
    upper: order < 0 ? up(estimate) : estimate,
  };
}

