import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  cmp,
  compareValue,
  createOracleEvaluator,
  type QTriple,
  q,
} from "./certified-staging-oracle.ts";
import {
  estimatePublicLayeredRelaxationPair,
  evaluatePublicLayeredRelaxationPair,
  type PublicLayeredInput,
} from "./certified-staging-oracle-public-layered-relaxation.ts";
import { evaluatePublicPathRelaxationPair } from "./certified-staging-oracle-public-path-relaxation.ts";

function request(): PublicLayeredInput {
  return {
    grade: "SR",
    level: 14,
    exp: 2400,
    prices: [q(10), q(1), q(20)],
    beforeStock: [40, 0, 0],
    afterStock: [40, 10, 0],
    finiteColors: [1, 2],
  };
}
function equivalent(
  actual: NonNullable<ReturnType<typeof evaluatePublicLayeredRelaxationPair>["before"]>,
  reference: ReturnType<ReturnType<typeof createOracleEvaluator>>,
) {
  expect(compareValue(actual, reference)).toBe(0);
  expect(
    actual.consumed.every((value, color) => {
      const expected = reference.consumed[color];
      assert(expected, "Expected reference consumption coordinate");
      return cmp(value, expected) === 0;
    }),
  ).toBe(true);
  const kit = ["blue", "purple", "yellow"];
  expect(actual.chosen < 0 ? "DONE" : kit[actual.chosen]).toBe(reference.action);
  expect(actual.mask).toBe(
    reference.ties.reduce((mask, action) => {
      if (action === "blue") return mask | 1;
      if (action === "purple") return mask | 2;
      if (action === "yellow") return mask | 4;
      return mask;
    }, 0),
  );
}
describe("independent public-DAG finite-layer retirement", () => {
  it("matches exact finite PBC/vector/chosen/ALL masks for24 nontrivial endpoint comparisons", () => {
    const families: readonly QTriple[] = [
      [q(10), q(1), q(20)],
      [q(1), q(2), q(4)],
      [q(1), q(1), q(1)],
    ];
    let checks = 0;
    for (const prices of families) {
      const oracle = createOracleEvaluator(prices);
      for (const [purple, yellow] of [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ] as const) {
        const input = {
          ...request(),
          prices,
          beforeStock: [40, purple * 10, yellow * 10] as const,
          afterStock: [40, (purple + 1) * 10, yellow * 10] as const,
        };
        const actual = evaluatePublicLayeredRelaxationPair(input);
        expect(actual.status).toBe("PASS");
        for (const endpoint of ["before", "after"] as const) {
          const value = actual[endpoint];
          assert(value, "Expected exact layered endpoint");
          equivalent(value, oracle({ ...input, stock: input[`${endpoint}Stock`] }));
          checks++;
        }
      }
    }
    expect(checks).toBe(24);
  });
  it("matches the frozen independent relaxation for every finite-color shape", () => {
    for (const finiteColors of [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]] as const) {
      const input = {
        ...request(),
        beforeStock: [40, 40, 40] as const,
        afterStock: [50, 50, 50] as const,
        finiteColors,
      };
      const actual = evaluatePublicLayeredRelaxationPair(input);
      const old = evaluatePublicPathRelaxationPair(input);
      expect(actual.status).toBe("PASS");
      for (const endpoint of ["before", "after"] as const) {
        const value = actual[endpoint];
        const reference = old[endpoint];
        assert(value && reference, "Expected matching relaxed endpoints");
        expect(compareValue(value, reference)).toBe(0);
        expect(
          value.consumed.every((amount, color) => {
            const expected = reference.consumed[color];
            assert(expected, "Expected reference consumption coordinate");
            return cmp(amount, expected) === 0;
          }),
        ).toBe(true);
        expect(value.mask).toBe(reference.mask);
        expect(value.chosen).toBe(reference.chosen);
      }
    }
  });
  it("keeps exactB equality until C and preserves every exact action tie", () => {
    const input = {
      ...request(),
      exp: 2600,
      prices: [q(10, 19), q(1000), q(1)] as const,
      beforeStock: [40, 10, 10] as const,
      afterStock: [40, 10, 10] as const,
    };
    const cTie = evaluatePublicLayeredRelaxationPair(input);
    expect(cTie.before?.chosen).toBe(2);
    expect(cTie.before?.mask).toBe(4);
    const allTies = evaluatePublicLayeredRelaxationPair({
      ...input,
      exp: 2900,
      prices: [q(1), q(1), q(1)],
    });
    expect(allTies.before?.mask).toBe(7);
    expect(allTies.before?.chosen).toBe(0);
    expect(allTies.strictOrder).toBe(0);
  });
  it("captures both roots even when the before finite inventory sum is larger", () => {
    const input = {
      ...request(),
      beforeStock: [40, 20, 10] as const,
      afterStock: [40, 0, 0] as const,
    };
    const result = evaluatePublicLayeredRelaxationPair(input);
    expect(result.status).toBe("PASS");
    const oracle = createOracleEvaluator(input.prices);
    const { before, after } = result;
    assert(before && after, "Expected both layered roots");
    equivalent(before, oracle({ ...input, stock: input.beforeStock }));
    equivalent(after, oracle({ ...input, stock: input.afterStock }));
    expect(result.strictOrder).toBe(-1);
  });
  it("separates136752 cumulative grid rows from9768 live rows before any table", () => {
    const plan = estimatePublicLayeredRelaxationPair({
      ...request(),
      level: 0,
      exp: 0,
      beforeStock: [3641, 230, 100],
      afterStock: [3641, 270, 100],
    });
    expect(plan.rootDepth).toBe(225);
    expect(plan.publicNodes).toBe(445);
    expect(plan.cumulativeRows).toBe(136752);
    expect(plan.maximumLiveRows).toBe(9768);
    expect(plan.admitted).toBe(true);
    expect(plan.logicalUpperBytes).toBeLessThan(160 * 1024 * 1024);
    expect(() => JSON.stringify(plan)).not.toThrow();
  });
  it("retains the planned live bound while retiring every old finite layer", () => {
    const input = {
      ...request(),
      beforeStock: [40, 30, 20] as const,
      afterStock: [40, 40, 30] as const,
    };
    const actual = evaluatePublicLayeredRelaxationPair(input);
    expect(actual.status).toBe("PASS");
    const plan = actual.plan;
    assert(plan, "Expected admitted layer plan");
    expect(actual.diagnostics.cumulativeRows).toBe(plan.cumulativeRows);
    expect(actual.diagnostics.peakLiveRows).toBe(plan.maximumLiveRows);
    expect(actual.diagnostics.cumulativeRows).toBeGreaterThan(actual.diagnostics.peakLiveRows);
  });
});
describe("independent layered admission and exact boundary controls", () => {
  it("rejects an unproved unlimited stock coordinate even if a chosen easy policy could fit", () => {
    const input = {
      ...request(),
      beforeStock: [20, 100, 100] as const,
      afterStock: [40, 100, 100] as const,
    };
    const result = evaluatePublicLayeredRelaxationPair(input);
    expect(result.status).toBe("NOTRUN");
    expect(result.reason).toBe("public_layered_stock_invariance_not_proved");
    expect(result.diagnostics.cumulativeRows).toBe(0);
  });
  it("respects row admission before allocating any worktable", () => {
    const result = evaluatePublicLayeredRelaxationPair(request(), { maxLiveRows: 1 });
    expect(result.reason).toBe("public_layered_live_row_admission");
    expect(result.plan?.admitted).toBe(false);
    expect(result.diagnostics.cumulativeRows).toBe(0);
    expect(result.before).toBeNull();
  });
  it("respects logical admission before allocating any worktable", () => {
    const plan = estimatePublicLayeredRelaxationPair(request());
    const result = evaluatePublicLayeredRelaxationPair(request(), {
      maxLogicalBytes: plan.logicalUpperBytes - 1,
    });
    expect(result.reason).toBe("public_layered_logical_admission");
    expect(result.diagnostics.cumulativeRows).toBe(0);
  });
  it("keeps deadline and unsupported conditions authoritative", () => {
    const expired = evaluatePublicLayeredRelaxationPair(request(), {
      deadlineAt: performance.now() - 1,
    });
    expect(expired.status).toBe("NOTRUN");
    expect(expired.reason).toBe("public_layered_deadline");
    expect(expired.rawException?.message).toBe(expired.reason);
    const unsupported = evaluatePublicLayeredRelaxationPair({
      ...request(),
      finiteColors: [0, 1, 2],
    });
    expect(unsupported.reason).toBe("public_layered_requires_unlimited_color");
    expect(unsupported.diagnostics.cumulativeRows).toBe(0);
  });
  it("rejects a sparse finite-color declaration before building a graph", () => {
    const colors: (0 | 1 | 2)[] = [];
    colors.length = 1;
    const result = evaluatePublicLayeredRelaxationPair({ ...request(), finiteColors: colors });
    expect(result.status).toBe("NOTRUN");
    expect(result.reason).toBe("public_layered_requires_unlimited_color");
    expect(result.plan).toBeNull();
  });
  it("does not convert extreme exact prices to floating point", () => {
    const tiny = q(1n, 1n << 5000n);
    const result = evaluatePublicLayeredRelaxationPair({
      ...request(),
      exp: 2900,
      prices: [tiny, q(1), q(2)],
      beforeStock: [40, 10, 10],
      afterStock: [40, 10, 10],
    });
    expect(result.status).toBe("PASS");
    const before = result.before;
    assert(before, "Expected exact-price endpoint");
    expect(cmp(before.B, q(10n, 1n << 5000n))).toBe(0);
  });
  it("returns exact terminal values without inventory rows", () => {
    const result = evaluatePublicLayeredRelaxationPair({
      ...request(),
      level: 15,
      exp: 0,
      beforeStock: [0, 0, 0],
      afterStock: [0, 0, 0],
    });
    expect(result.status).toBe("PASS");
    const before = result.before;
    assert(before, "Expected terminal endpoint");
    expect(cmp(before.P, q(1))).toBe(0);
    expect(result.before?.mask).toBe(0);
    expect(result.diagnostics.cumulativeRows).toBe(0);
  });
});
