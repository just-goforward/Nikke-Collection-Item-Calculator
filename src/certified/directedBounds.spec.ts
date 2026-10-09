import { assert, describe, expect, it } from "vitest";
import { add, cmp, fromBinary64, mul, q } from "../../shared/certifiedRational";
import { BoundArena } from "./boundArena";
import { WorkBudget } from "./budget";
import {
  consumptionBound,
  outwardWidth,
  positiveDown,
  positiveUp,
  possibleActions,
  rationalBound,
  UNKNOWN_BOUND,
  weightedBound,
} from "./directedBounds";

describe("certified directed bounds", () => {
  it("widens unsupported arithmetic and width overflow to UNKNOWN", () => {
    expect(positiveUp(Infinity)).toBe(Infinity);
    expect(positiveUp(NaN)).toBe(Infinity);
    expect(positiveDown(Infinity)).toBe(0);
    expect(positiveDown(-0)).toBe(0);
    expect(outwardWidth(0, Number.MAX_VALUE)).toBeNull();
    expect(weightedBound(500, { lo: 0, hi: Infinity }, { lo: 1, hi: 1 })).toEqual(UNKNOWN_BOUND);
    expect(weightedBound(1001, { lo: 0, hi: 0 }, { lo: 1, hi: 1 })).toEqual(UNKNOWN_BOUND);
    expect(
      consumptionBound({ lo: 0, hi: 0 }, { lo: Number.MAX_VALUE, hi: Number.MAX_VALUE }),
    ).toEqual(UNKNOWN_BOUND);
    expect(rationalBound({ n: 1n << 5000n, d: 1n })).toEqual(UNKNOWN_BOUND);
  });
  it("does not clip large finite expectations", () => {
    const result = weightedBound(500, { lo: 1e301, hi: 1e301 }, { lo: 1e301, hi: 1e301 });
    expect(result.lo).toBeGreaterThan(1e300);
    expect(result.lo).toBeLessThanOrEqual(1e301);
    expect(result.hi).toBeGreaterThanOrEqual(1e301);
  });
  it("encloses rational expectations including subnormals", () => {
    for (const p of [0, 36, 300, 700, 1000]) {
      for (const a of [0, Number.MIN_VALUE, 0.1, 2250]) {
        for (const b of [0, Number.MIN_VALUE, 0.7, 2250]) {
          const exact = add(
            mul(q(p, 1000), fromBinary64(a)),
            mul(q(1000 - p, 1000), fromBinary64(b)),
          );
          const bound = weightedBound(p, { lo: a, hi: a }, { lo: b, hi: b });
          expect(cmp(fromBinary64(bound.lo), exact)).toBeLessThanOrEqual(0);
          expect(cmp(fromBinary64(bound.hi), exact)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
  it("keeps equality, overlap and UNKNOWN candidates", () => {
    expect(possibleActions([{ lo: NaN, hi: NaN }, { lo: 1, hi: 1 }, null])).toBe(3);
    expect(possibleActions([{ lo: 1, hi: 1 }, { lo: 1, hi: 1 }, UNKNOWN_BOUND])).toBe(7);
    expect(possibleActions([{ lo: 1, hi: 2 }, { lo: 1.5, hi: 3 }, null])).toBe(3);
    expect(possibleActions([{ lo: 1, hi: 2 }, { lo: 2.01, hi: 3 }, null])).toBe(1);
  });
  it("packs widths outward and rejects index aliases", () => {
    const budget = new WorkBudget({}, performance.now());
    const arena = BoundArena.create(550, [8, 3, 2], true, budget);
    assert(arena);
    const units: [number, number, number] = [1, 1, 1];
    arena.put("cost", 550, units, { lo: 0.1, hi: positiveUp(0.1) });
    const stored = arena.get("cost", 550, units);
    assert(stored);
    expect(stored.hi).toBeGreaterThanOrEqual(positiveUp(0.1));
    expect(arena.get("cost", 550, [2, 1, 1])).toBeNull();
    expect(() => arena.get("cost", 550, [1, 4, 0])).toThrow("outside_domain");
    expect(() => arena.get("cost", 549, units)).toThrow("outside_domain");
    expect(() => arena.get("cost", 550.5, units)).toThrow("outside_domain");
    const sparse: [number, number, number] = [1, 1, 1];
    Reflect.deleteProperty(sparse, 1);
    expect(() => arena.get("cost", 550, sparse)).toThrow("outside_domain");
    expect(outwardWidth(0, Number.MIN_VALUE)).toBeGreaterThanOrEqual(Number.MIN_VALUE);
  });
  it("admits each page before allocation and accounts its release", () => {
    const budget = new WorkBudget({}, performance.now());
    const arena = BoundArena.create(0, [60, 10, 4], true, budget);
    assert(arena);
    const layoutBytes = arena.bytes;
    expect(budget.managedPayloadBytes).toBe(layoutBytes);
    arena.put("failure", 0, [60, 10, 4], { lo: 0.1, hi: 0.2 });
    const onePage = arena.bytes;
    expect(onePage - layoutBytes).toBe(4096 * 13 + 40);
    arena.put("cost", 0, [60, 10, 4], { lo: 2, hi: 3 });
    expect(arena.bytes - onePage).toBe(4096 * 13 + 40);
    expect(budget.managedPayloadBytes).toBe(arena.bytes);
    budget.release(arena.bytes);
    expect(budget.managedPayloadBytes).toBe(0);
    const tight = new WorkBudget({ maxManagedPayloadBytes: 10000 }, performance.now());
    const omitted = BoundArena.create(0, [60, 10, 4], true, tight);
    assert(omitted);
    omitted.put("cost", 0, [60, 10, 4], { lo: 2, hi: 3 });
    expect(omitted.get("cost", 0, [60, 10, 4])).toBeNull();
    expect(tight.managedPayloadBytes).toBe(omitted.bytes);
  });
});
