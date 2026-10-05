// Exact rational arithmetic on BigInt, plus exact decoding of binary64 values.
// Every Q is kept reduced with a positive denominator.

export type Q = { readonly n: bigint; readonly d: bigint };
export type WireQ = { numerator: string; denominator: string };

export const ZERO: Q = Object.freeze({ n: 0n, d: 1n });
export const ONE: Q = Object.freeze({ n: 1n, d: 1n });

export function gcd(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export function q(n: bigint | number, d: bigint | number = 1n): Q {
  if (typeof n === "number" && !Number.isSafeInteger(n))
    throw new RangeError("rational: unsafe integer numerator");
  if (typeof d === "number" && !Number.isSafeInteger(d))
    throw new RangeError("rational: unsafe integer denominator");
  let nn = BigInt(n);
  let dd = BigInt(d);
  if (dd === 0n) throw new RangeError("rational: zero denominator");
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  const g = gcd(nn, dd);
  return g === 1n ? { n: nn, d: dd } : { n: nn / g, d: dd / g };
}

export const add = (a: Q, b: Q): Q =>
  a.n === 0n ? b : b.n === 0n ? a : q(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Q, b: Q): Q => (a.n === 0n || b.n === 0n ? ZERO : q(a.n * b.n, a.d * b.d));
export const div = (a: Q, b: Q): Q => {
  if (b.n === 0n) throw new RangeError("rational: division by zero");
  return q(a.n * b.d, a.d * b.n);
};
export const cmp = (a: Q, b: Q): -1 | 0 | 1 => {
  const x = a.n * b.d - b.n * a.d;
  return x < 0n ? -1 : x > 0n ? 1 : 0;
};
export const eq = (a: Q, b: Q): boolean => a.n === b.n && a.d === b.d;
export const isZero = (a: Q): boolean => a.n === 0n;
export const bits = (a: Q): number => Math.max(a.n.toString(2).length, a.d.toString(2).length);

export function sum(values: readonly Q[]): Q {
  let s = ZERO;
  for (const v of values) s = add(s, v);
  return s;
}

export const toWire = (a: Q): WireQ => ({ numerator: a.n.toString(), denominator: a.d.toString() });
export function fromWire(w: WireQ): Q {
  if (!/^-?\d+$/.test(w.numerator) || !/^\d+$/.test(w.denominator))
    throw new TypeError("rational: bad wire");
  return q(BigInt(w.numerator), BigInt(w.denominator));
}
export const formatRational = (a: Q): string => (a.d === 1n ? a.n.toString() : `${a.n}/${a.d}`);
export { formatRational as toString };
export function parse(s: string): Q {
  const m = /^(-?\d+)(?:\/(\d+))?$/.exec(s);
  if (!m) throw new TypeError(`rational: cannot parse ${s}`);
  return q(BigInt(m[1]!), BigInt(m[2] ?? "1"));
}

/** Nearest double of a rational (round-to-nearest, via BigInt scaling). */
export function toNumber(a: Q): number {
  if (a.n === 0n) return 0;
  const neg = a.n < 0n;
  const n = neg ? -a.n : a.n;
  // Scale so the integer quotient carries ~64 significant bits, convert, then undo the scale in safe steps.
  const shift = 64 - (n.toString(2).length - a.d.toString(2).length);
  const scaled = shift >= 0 ? (n << BigInt(shift)) / a.d : n / (a.d << BigInt(-shift));
  let value = Number(scaled);
  let k = -shift;
  while (k > 1000) {
    value *= 2 ** 1000;
    k -= 1000;
  }
  while (k < -1000) {
    value *= 2 ** -1000;
    k += 1000;
  }
  value *= 2 ** k;
  return neg ? -value : value;
}

// ---------------------------------------------------------------- binary64

const scratch = new DataView(new ArrayBuffer(8));

/** Big-endian hex of the IEEE-754 bits, as used by the research wire format. */
export function binary64Bits(value: number): string {
  scratch.setFloat64(0, value);
  let s = "";
  for (let i = 0; i < 8; i++) s += scratch.getUint8(i).toString(16).padStart(2, "0");
  return s;
}

/** Exact rational value of a finite double. */
export function fromBinary64(value: number): Q {
  if (!Number.isFinite(value)) throw new RangeError("rational: non-finite double");
  scratch.setFloat64(0, value);
  const hi = scratch.getUint32(0);
  const lo = scratch.getUint32(4);
  const bitsAll = (BigInt(hi) << 32n) | BigInt(lo);
  const sign = bitsAll >> 63n ? -1n : 1n;
  const exp = Number((bitsAll >> 52n) & 0x7ffn);
  let mant = bitsAll & ((1n << 52n) - 1n);
  if (exp) mant += 1n << 52n;
  const shift = exp ? exp - 1023 - 52 : -1074;
  return shift >= 0 ? q(sign * (mant << BigInt(shift))) : q(sign * mant, 1n << BigInt(-shift));
}

// ---------------------------------------------------------------- outward-rounded intervals on doubles

/** Smallest double strictly greater than x (x finite). */
export function nextUp(x: number): number {
  if (Number.isNaN(x) || x === Infinity) return x;
  if (x === 0) return Number.MIN_VALUE;
  scratch.setFloat64(0, x);
  const b = scratch.getBigUint64(0);
  scratch.setBigUint64(0, x > 0 ? b + 1n : b - 1n);
  return scratch.getFloat64(0);
}

/** Largest double strictly less than x (x finite). */
export function nextDown(x: number): number {
  return -nextUp(-x);
}

export type Interval = { readonly lo: number; readonly hi: number };

export const point = (x: number): Interval => ({ lo: x, hi: x });
export function iadd(a: Interval, b: Interval): Interval {
  return { lo: nextDown(a.lo + b.lo), hi: nextUp(a.hi + b.hi) };
}
/** Product of two nonnegative intervals. */
export function imulNonneg(a: Interval, b: Interval): Interval {
  const lo = a.lo * b.lo;
  const hi = a.hi * b.hi;
  return { lo: lo === 0 ? 0 : nextDown(lo), hi: hi === 0 ? 0 : nextUp(hi) };
}
/** Enclosure of a rational as a double interval. */
export function qInterval(a: Q): Interval {
  const x = toNumber(a);
  const c = cmp(fromBinary64(x), a);
  return c === 0 ? point(x) : c < 0 ? { lo: x, hi: nextUp(x) } : { lo: nextDown(x), hi: x };
}
