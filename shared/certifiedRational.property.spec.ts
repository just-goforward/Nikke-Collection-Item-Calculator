import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Q, q, qInterval, toNumber } from "./certifiedRational.ts";
import { assertProperty, expectDefectProperty, type PropertyIdentity } from "./propertyHarness.ts";

/* S1/P2. Expected doubles come only from IEEE-754 bit patterns decoded with
 * DataView (anchored below on literals parsed by the JS engine) and from exact
 * BigInt cross-multiplication. Nothing here calls fromBinary64, nextUp,
 * nextDown or cmp from the module under test. */

const IDENTITY: PropertyIdentity = {
  file: "shared/certifiedRational.property.spec.ts",
  generatorSource: readFileSync("shared/certifiedRational.property.spec.ts", "utf8"),
  sources: { "shared/certifiedRational.ts": readFileSync("shared/certifiedRational.ts", "utf8") },
};
const NUM_RUNS = 100;
const TIME_LIMIT_MS = 10_000;
const HARD_DEADLINE_MS = 20_000;

const MAX_BITS = 0x7fef_ffff_ffff_ffffn;
const view = new DataView(new ArrayBuffer(8));
function fromBits(bits: bigint): number {
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}
function toBits(value: number): bigint {
  view.setFloat64(0, value);
  return view.getBigUint64(0);
}

/** Exact rational (unreduced) with a positive denominator. */
type R = { n: bigint; d: bigint };
const sign = (value: bigint) => (value > 0n ? 1 : value < 0n ? -1 : 0);
const compare = (a: R, b: R) => sign(a.n * b.d - b.n * a.d);
const pow2 = (exponent: number): R =>
  exponent >= 0 ? { n: 1n << BigInt(exponent), d: 1n } : { n: 1n, d: 1n << BigInt(-exponent) };
const plus = (a: R, b: R): R => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });

/** Exact value m * 2^e of a nonnegative finite bit pattern (IEEE-754 binary64). */
function exactOfBits(bits: bigint): { m: bigint; e: number; value: R } {
  const biased = Number(bits >> 52n);
  const fraction = bits & ((1n << 52n) - 1n);
  const m = biased === 0 ? fraction : fraction | (1n << 52n);
  const e = biased === 0 ? -1074 : biased - 1075;
  const scale = pow2(e);
  return { m, e, value: { n: m * scale.n, d: scale.d } };
}
/** Exact value of a finite double, derived from its bits. */
function exactOfDouble(value: number): R {
  const bits = toBits(Math.abs(value));
  const exact = exactOfBits(bits).value;
  return value < 0 || Object.is(value, -0) ? { n: -exact.n, d: exact.d } : exact;
}
/** Midpoint between the nonnegative double `bits` and its successor `bits + 1`. */
function upperMidpoint(bits: bigint): R {
  const { e, value } = exactOfBits(bits);
  return plus(value, pow2(e - 1));
}

describe("P2 binary64 reference anchors", () => {
  it("decodes known bit patterns to engine-parsed literals and exact values", () => {
    expect(fromBits(0x3ff0_0000_0000_0000n)).toBe(1);
    expect(fromBits(0x3fb9_9999_9999_999an)).toBe(0.1);
    expect(fromBits(1n)).toBe(Number.MIN_VALUE);
    expect(fromBits(0x0010_0000_0000_0000n)).toBe(2.2250738585072014e-308);
    expect(fromBits(MAX_BITS)).toBe(Number.MAX_VALUE);
    expect(fromBits(MAX_BITS + 1n)).toBe(Infinity);
    expect(fromBits(0x3ff0_0000_0000_0001n)).toBe(1 + Number.EPSILON);
    expect(fromBits(0x3cb0_0000_0000_0000n)).toBe(Number.EPSILON);
    expect(
      compare(exactOfBits(0x3fb9_9999_9999_999an).value, { n: 3602879701896397n, d: 1n << 55n }),
    ).toBe(0);
    expect(compare(exactOfBits(1n).value, { n: 1n, d: 1n << 1074n })).toBe(0);
    expect(compare(upperMidpoint(0n), { n: 1n, d: 1n << 1075n })).toBe(0);
    // The overflow threshold MAX + 2^970 = 2^1024 - 2^970.
    expect(compare(upperMidpoint(MAX_BITS), { n: (1n << 1024n) - (1n << 970n), d: 1n })).toBe(0);
  });
});

/** A rational r with its correctly rounded double and the two doubles bracketing r. */
type Case = { r: R; expected: number; below: number; above: number; label: string };

/** Interior: r strictly between the midpoints around the double `bits`, any denominator. */
const interiorCase = fc
  .record({
    bits: fc.oneof(
      fc.bigInt({ min: 1n, max: MAX_BITS }),
      fc.bigInt({ min: 1n, max: (1n << 52n) - 1n }),
      fc.bigInt({ min: 0x3fe0_0000_0000_0000n, max: 0x4010_0000_0000_0000n }),
      fc.bigInt({ min: MAX_BITS - 4096n, max: MAX_BITS }),
    ),
    k: fc.bigInt({ min: 1n, max: (1n << 80n) - 1n }),
    u: fc.bigInt({ min: 0n, max: (1n << 120n) - 1n }),
    negative: fc.boolean(),
  })
  .map(({ bits, k, u, negative }): Case => {
    const x = exactOfBits(bits).value;
    const low = upperMidpoint(bits - 1n);
    const high = upperMidpoint(bits);
    // Common denominator of the dyadic endpoints, then scale by k.
    const d = low.d > high.d ? low.d : high.d;
    const a = (low.n * d) / low.d;
    const b = (high.n * d) / high.d;
    const span = (b - a) * k;
    const r: R = { n: a * k + 1n + (u % (span - 1n)), d: d * k };
    const side = compare(r, x);
    const xd = fromBits(bits);
    const below = side < 0 ? fromBits(bits - 1n) : xd;
    const above = side > 0 ? fromBits(bits + 1n) : xd;
    return negate({ r, expected: xd, below, above, label: "interior" }, negative);
  });

/** Near and exact ties at the midpoint between `bits` and `bits + 1`, including
 * the subnormal/zero boundary and the overflow threshold above MAX_VALUE. */
const tieCase = fc
  .record({
    bits: fc.oneof(
      fc.bigInt({ min: 0n, max: MAX_BITS }),
      fc.bigInt({ min: 0n, max: (1n << 52n) - 1n }),
      fc.bigInt({ min: 0x3fe0_0000_0000_0000n, max: 0x4010_0000_0000_0000n }),
      fc.bigInt({ min: MAX_BITS - 4096n, max: MAX_BITS }),
    ),
    k: fc.bigInt({ min: 1n, max: (1n << 100n) - 1n }),
    offset: fc.constantFrom(-1n, 0n, 1n),
    negative: fc.boolean(),
  })
  .map(({ bits, k, offset, negative }): Case => {
    const mid = upperMidpoint(bits);
    const r: R = { n: mid.n * k + offset, d: mid.d * k };
    const xd = fromBits(bits);
    const next = fromBits(bits + 1n);
    // Ties go to the even significand; the bit pattern's low bit is its parity.
    // MAX_VALUE is odd, so its tie rounds to Infinity (IEEE-754 overflow rule).
    let expected = offset < 0n ? xd : next;
    if (offset === 0n) expected = (bits & 1n) === 0n ? xd : next;
    const label = offset === 0n ? "tie" : offset < 0n ? "below-tie" : "above-tie";
    return negate({ r, expected, below: xd, above: next, label }, negative);
  });

function negate(value: Case, negative: boolean): Case {
  if (!negative) return value;
  return {
    r: { n: -value.r.n, d: value.r.d },
    expected: -value.expected,
    below: -value.above,
    above: -value.below,
    label: `-${value.label}`,
  };
}
const asQ = (r: R): Q => q(r.n, r.d);
const anyCase = fc.oneof(interiorCase, tieCase);

describe("P2 toNumber against the bit-pattern reference", () => {
  it(
    "is faithful: the result is one of the two doubles bracketing r",
    async () => {
      await assertProperty(
        fc.property(anyCase, (c) => {
          const actual = toNumber(asQ(c.r));
          return Object.is(actual, c.below) || Object.is(actual, c.above);
        }),
        { name: "P2.faithful", numRuns: NUM_RUNS, timeLimitMs: TIME_LIMIT_MS, identity: IDENTITY },
      );
    },
    HARD_DEADLINE_MS,
  );

  it.fails(
    "DEFECT-P2-01 is correctly rounded (nearest, ties-to-even) on interior and tie cases",
    async () => {
      await expectDefectProperty(
        fc.property(anyCase, (c) => Object.is(toNumber(asQ(c.r)), c.expected)),
        {
          name: "P2.correctly-rounded",
          numRuns: NUM_RUNS,
          timeLimitMs: TIME_LIMIT_MS,
          identity: IDENTITY,
        },
      );
    },
    HARD_DEADLINE_MS,
  );

  it("rounds exact doubles, exact ties and the overflow domain per IEEE-754", () => {
    const one = 1n << 52n;
    // Exact ties with no discarded bits: (1 + 2^-53) -> 1, (1 + 3*2^-53) -> 1 + 2^-51.
    expect(toNumber(q(2n * one + 1n, 2n * one))).toBe(1);
    expect(toNumber(q(2n * one + 3n, 2n * one))).toBe(fromBits(0x3ff0_0000_0000_0002n));
    expect(toNumber(q(-(2n * one + 1n), 2n * one))).toBe(-1);
    // Smallest subnormal tie 2^-1075 goes to the even neighbour 0; 3*2^-1076 is above it.
    expect(toNumber(q(1n, 1n << 1075n))).toBe(0);
    expect(toNumber(q(3n, 1n << 1076n))).toBe(Number.MIN_VALUE);
    expect(toNumber(q(1n, 1n << 1074n))).toBe(Number.MIN_VALUE);
    // Overflow: below the threshold MAX + 2^970 stays MAX; at/above it is Infinity.
    const threshold = (1n << 1024n) - (1n << 970n);
    expect(toNumber(q(threshold - 1n))).toBe(Number.MAX_VALUE);
    expect(toNumber(q(threshold))).toBe(Infinity);
    expect(toNumber(q(1n << 1100n))).toBe(Infinity);
    expect(toNumber(q(-(1n << 5000n)))).toBe(-Infinity);
    expect(toNumber(q(0))).toBe(0);
  });

  it("places every DEFECT-P2-01 witness strictly inside its expected double's rounding interval", () => {
    const witnesses: [R, number][] = [
      [{ n: (1n << 65n) + (1n << 12n) + 1n, d: 1n << 65n }, fromBits(0x3ff0_0000_0000_0001n)],
      [{ n: (1n << 925n) + 1n, d: 1n << 2000n }, Number.MIN_VALUE],
      [
        { n: 116936475474397122161549626048513n, d: 162259276829213363391578010288128n },
        0.7206766710631841,
      ],
    ];
    for (const [r, expected] of witnesses) {
      const bits = toBits(expected);
      expect(compare(r, upperMidpoint(bits - 1n))).toBe(1);
      expect(compare(r, upperMidpoint(bits))).toBe(-1);
    }
  });

  // Minimized witnesses of DEFECT-P2-01 (missing sticky bit / double rounding).
  it.fails("DEFECT-P2-01 witness (2^65+2^12+1)/2^65 rounds to nextUp(1)", () => {
    expect(toNumber(q((1n << 65n) + (1n << 12n) + 1n, 1n << 65n))).toBe(
      fromBits(0x3ff0_0000_0000_0001n),
    );
  });
  it.fails("DEFECT-P2-01 witness 2^-1075 + 2^-2000 rounds to MIN_VALUE", () => {
    expect(toNumber(q((1n << 925n) + 1n, 1n << 2000n))).toBe(Number.MIN_VALUE);
  });
  // Shrunk by fast-check (seed 20260720, P2.correctly-rounded): one numerator unit
  // above the lower midpoint of 0.7206766710631841, rounded down to its predecessor.
  it.fails("DEFECT-P2-01 shrunk witness just above a lower midpoint keeps the nearest double", () => {
    const r = q(116936475474397122161549626048513n, 162259276829213363391578010288128n);
    expect(toNumber(r)).toBe(0.7206766710631841);
  });
});

describe("P2 qInterval encloses the exact value", () => {
  // Finite domain only: qInterval of an overflowing rational is outside its contract.
  const finiteCase = fc.oneof(
    interiorCase,
    tieCase.filter(
      (c) => Number.isFinite(c.below) && Number.isFinite(c.above) && Number.isFinite(c.expected),
    ),
  );
  it(
    "lo <= r <= hi exactly, width at most one ulp, and a point only for exact doubles",
    async () => {
      await assertProperty(
        fc.property(finiteCase, (c) => {
          const { lo, hi } = qInterval(asQ(c.r));
          if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
          if (compare(exactOfDouble(lo), c.r) > 0 || compare(exactOfDouble(hi), c.r) < 0)
            return false;
          if (lo === hi) return compare(exactOfDouble(lo), c.r) === 0;
          // Adjacent doubles: hi is the successor of lo in the total order.
          const step = (value: number) =>
            value < 0 || Object.is(value, -0) ? -toBits(-value) : toBits(value);
          return step(hi) - step(lo) === 1n || (lo === 0 && hi === Number.MIN_VALUE);
        }),
        { name: "P2.qInterval", numRuns: NUM_RUNS, timeLimitMs: TIME_LIMIT_MS, identity: IDENTITY },
      );
    },
    HARD_DEADLINE_MS,
  );
});
