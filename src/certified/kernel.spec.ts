import { describe, expect, it } from "vitest";
import { eq, q } from "../../shared/certifiedRational";
import { WorkBudget } from "./budget";
import { CAPS, encode } from "./game";
import { FiniteKernel } from "./kernel";

function kernel(weights = [q(1), q(1), q(1)] as const): FiniteKernel {
  return new FiniteKernel(weights, new WorkBudget({}, performance.now()));
}
describe("certified exact finite-inventory objectives", () => {
  it("uses total expected consumption to break an exact P/B tie", () => {
    // SR14/2600: one yellow finishes; blue finishes in 1 use with .1,
    // otherwise 2. Both have P=1 and B=10 under the exact prices below.
    const candidate = kernel([q(10, 19), q(1), q(1)]);
    const value = candidate.actualValue(candidate.solve(encode("SR", 14, 2600), [20, 0, 10]));
    expect(eq(value.p, q(1))).toBe(true);
    expect(eq(value.b, q(10))).toBe(true);
    expect(eq(value.c, q(10))).toBe(true);
    expect(value.mask).toBe(4);
  });
  it("preserves all inventory when success has probability exactly zero", () => {
    const value = kernel().solve(encode("R", 0, 0), [10, 0, 0]);
    expect(eq(value.p, q(0))).toBe(true);
    expect(eq(value.b, q(0))).toBe(true);
    expect(eq(value.c, q(0))).toBe(true);
    expect(value.mask).toBe(0);
  });
  it("retains exact action ties without using display rounding", () => {
    const value = kernel().solve(encode("SR", 14, 2900), [10, 10, 10]);
    expect(value.mask).toBe(7);
    expect(eq(value.p, q(1))).toBe(true);
    expect(eq(value.c, q(10))).toBe(true);
  });
  it("does not drop a rare but positive terminal-success probability", () => {
    const value = kernel().solve(encode("SR", 10, 0), [10, 0, 0]);
    expect(eq(value.p, q(12, 1000))).toBe(true);
    expect(eq(value.c, q(10))).toBe(true);
    expect(value.mask).toBe(1);
  });
  it("caps stock only after fixing prices and preserves the exact vector", () => {
    const sid = encode("SR", 14, 0);
    const candidate = kernel([q(1, 100), q(1, 20), q(1, 10)]);
    const cap = CAPS[sid]!.map((n) => n * 10) as [number, number, number];
    const a = candidate.solve(sid, cap);
    const b = candidate.solve(sid, [100_000, 100_000, 100_000]);
    expect(eq(a.p, b.p) && eq(a.b, b.b) && eq(a.c, b.c)).toBe(true);
    expect(a.consumed.every((v, k) => eq(v, b.consumed[k]!))).toBe(true);
  });
});
