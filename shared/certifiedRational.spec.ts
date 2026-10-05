import { describe, expect, it } from "vitest";
import {
  add,
  cmp,
  fromBinary64,
  fromWire,
  q,
  qInterval,
  toNumber,
  toWire,
} from "./certifiedRational.ts";

describe("certified rational arithmetic", () => {
  it("reduces fractions and serializes without BigInt in JSON", () => {
    expect(q(1197, 39)).toEqual({ n: 399n, d: 13n });
    const wire = JSON.parse(JSON.stringify(toWire(q(-10, -20))));
    expect(wire).toEqual({ numerator: "1", denominator: "2" });
    expect(fromWire(wire)).toEqual(q(1, 2));
    expect(() => fromWire({ numerator: "1", denominator: "0" })).toThrow();
    expect(() => fromWire({ numerator: "1.5", denominator: "2" })).toThrow();
    expect(() => q(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
  it("keeps decimal source probabilities separate from binary64 approximations", () => {
    expect(cmp(fromBinary64(0.1), q(1, 10))).toBe(1);
    expect(add(q(1, 10), q(2, 10))).toEqual(q(3, 10));
    expect(toNumber(q(2764, 10))).toBe(276.4);
    const bounds = qInterval(q(1, 10));
    expect(cmp(fromBinary64(bounds.lo), q(1, 10))).toBeLessThanOrEqual(0);
    expect(cmp(fromBinary64(bounds.hi), q(1, 10))).toBeGreaterThanOrEqual(0);
  });
});
