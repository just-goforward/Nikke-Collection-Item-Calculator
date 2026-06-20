import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { KIT_ORDER, normalizeState, normalizeStock, transition } from "./solver/domain";

const propertyOptions = { numRuns: 300, seed: 20260620 };
const gradeArbitrary = fc.constantFrom("R", "SR" as const);
const stateArbitrary = fc.record({
  grade: gradeArbitrary,
  level: fc.integer({ min: -20, max: 40 }),
  exp: fc.integer({ min: -10_000, max: 30_000 }),
});
const stockArbitrary = fc.record({
  blue: fc.integer({ min: -10_000, max: 100_000 }),
  purple: fc.integer({ min: -10_000, max: 100_000 }),
  yellow: fc.integer({ min: -10_000, max: 100_000 }),
});

describe("solver domain properties", () => {
  it("normalizes arbitrary states into the finite solver domain", () => {
    fc.assert(
      fc.property(stateArbitrary, (state) => {
        const normalized = normalizeState(state);
        expect(normalized.grade === "R" || normalized.grade === "SR").toBe(true);
        expect(Number.isInteger(normalized.level)).toBe(true);
        expect(normalized.level).toBeGreaterThanOrEqual(0);
        expect(normalized.level).toBeLessThanOrEqual(15);
        expect(Number.isInteger(normalized.exp)).toBe(true);
        expect(normalized.exp).toBeGreaterThanOrEqual(0);
        if (normalized.level === 15) expect(normalized.exp).toBe(0);
      }),
      propertyOptions,
    );
  });

  it("keeps every kit transition finite and probability-bounded", () => {
    fc.assert(
      fc.property(stateArbitrary, fc.constantFrom(...KIT_ORDER), (state, kit) => {
        const normalized = normalizeState(state);
        const edge = transition(state, kit);
        expect(Number.isFinite(edge.probability)).toBe(true);
        expect(edge.probability).toBeGreaterThanOrEqual(0);
        expect(edge.probability).toBeLessThanOrEqual(1);
        expect(edge.success).toEqual(normalizeState(edge.success));
        expect(edge.fail).toEqual(normalizeState(edge.fail));
        if (normalized.level === 15) {
          expect(edge.probability).toBe(0);
          expect(edge.success).toEqual(normalized);
          expect(edge.fail).toEqual(normalized);
        }
      }),
      propertyOptions,
    );
  });

  it("normalizes stock into non-negative integer pieces without changing kit keys", () => {
    fc.assert(
      fc.property(stockArbitrary, (stock) => {
        const normalized = normalizeStock(stock);
        expect(Object.keys(normalized).sort()).toEqual(["blue", "purple", "yellow"]);
        for (const kit of KIT_ORDER) {
          expect(Number.isInteger(normalized[kit])).toBe(true);
          expect(normalized[kit]).toBeGreaterThanOrEqual(0);
        }
      }),
      propertyOptions,
    );
  });
});
