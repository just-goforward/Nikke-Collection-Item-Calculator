import { describe, expect, it } from "vitest";
import { q } from "../../shared/certifiedRational";
import { CertifiedLimit, WorkBudget } from "./budget";
import { GuidanceArithmetic } from "./guidanceArithmetic";
import { IntegerFiniteTable } from "./integerTable";
import type { ExactValue } from "./value";

// Baseline recurrence: seed 1; each appended slot multiplies by 1000.
// Reservations for 1000, 1000000 and 1000000000 are 26, 27 and 28 bytes.
const complete: ExactValue = {
  p: q(1),
  b: q(10),
  c: q(10),
  consumed: [q(10), q(0), q(0)],
  mask: 1,
};

function integerTable(budget: WorkBudget): IntegerFiniteTable {
  return new IntegerFiniteTable([1n, 1n, 1n], budget, () => ({
    value: complete,
    bound: [1, 0, 0],
    actions: [],
  }));
}

describe("nonempty certified power caches", () => {
  it("retains the seed, extends densely and charges only newly appended guidance powers", () => {
    const budget = new WorkBudget({}, performance.now());
    const arithmetic = new GuidanceArithmetic([1n, 1n, 1n], budget);
    expect([0, 1, 3, 2, 3].map((exponent) => arithmetic.power(exponent))).toEqual([
      1n,
      1000n,
      1000000000n,
      1000000n,
      1000000000n,
    ]);
    expect(budget.managedPayloadBytes).toBe(81);
    for (const exponent of [-1, NaN, 0.5, Infinity]) {
      expect(() => arithmetic.power(exponent)).toThrow(new Error("certified_guidance_lift"));
    }
    expect(budget.managedPayloadBytes).toBe(81);
    expect(arithmetic.power(0)).toBe(1n);
  });

  it("uses the same seeded integer recurrence across smaller and terminal exponent requests", () => {
    const budget = new WorkBudget({}, performance.now());
    const table = integerTable(budget);
    expect(table.value(599, [1, 1, 1])).toEqual(complete);
    expect(table.value(599, [1, 0, 0])).toEqual(complete);
    expect(table.value(600, [0, 0, 0])).toEqual({
      p: q(1),
      b: q(0),
      c: q(0),
      consumed: [q(0), q(0), q(0)],
      mask: 0,
    });
    expect(budget.managedPayloadBytes).toBe(81);
  });

  it.each(["guidance", "integer"] as const)(
    "keeps the appended %s power after its reservation throws, without another reservation",
    (kind) => {
      const budget = new WorkBudget({ maxManagedPayloadBytes: 1 }, performance.now());
      const arithmetic = new GuidanceArithmetic([1n, 1n, 1n], budget);
      const table = integerTable(budget);
      const request = () =>
        kind === "guidance" ? arithmetic.power(1) : table.value(599, [1, 0, 0]);
      expect(request).toThrow(new CertifiedLimit("managed_payload_ceiling"));
      expect(budget.managedPayloadBytes).toBe(26);
      expect(request()).toEqual(kind === "guidance" ? 1000n : complete);
      expect(budget.managedPayloadBytes).toBe(26);
      expect(budget.managedPayloadPeakBytes).toBe(26);
    },
  );
});
