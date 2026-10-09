import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import {
  cmp,
  compareValue,
  createOracleEvaluator,
  type QTriple,
  q,
} from "./certified-staging-oracle.ts";
import {
  estimatePublicLayeredFeasibility,
  evaluatePublicLayeredFeasibility,
  type PublicFeasibilityInput,
} from "./certified-staging-oracle-public-layered-feasibility.ts";
import { estimatePublicLayeredRelaxationPair } from "./certified-staging-oracle-public-layered-relaxation.ts";
import { evaluatePublicPathRelaxationPair } from "./certified-staging-oracle-public-path-relaxation.ts";

function request(): PublicFeasibilityInput {
  return {
    grade: "SR",
    level: 14,
    exp: 2400,
    prices: [q(10), q(1), q(20)],
    stock: [40, 0, 0],
    finiteColors: [1, 2],
  };
}
function equivalent(
  actual: NonNullable<ReturnType<typeof evaluatePublicLayeredFeasibility>["value"]>,
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
  expect(actual.chosen < 0 ? "DONE" : ["blue", "purple", "yellow"][actual.chosen]).toBe(
    reference.action,
  );
  expect(actual.mask).toBe(
    reference.ties.reduce((mask, action) => {
      if (action === "blue") return mask | 1;
      if (action === "purple") return mask | 2;
      if (action === "yellow") return mask | 4;
      return mask;
    }, 0),
  );
}

describe("ALL-tied-optimal-policy stock feasibility", () => {
  it("matches24 uncapped finite PBC/vector/chosen/ALL-mask controls", () => {
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
        [2, 0],
        [2, 1],
        [0, 2],
        [1, 2],
      ] as const) {
        const input = { ...request(), prices, stock: [40, purple * 10, yellow * 10] as const };
        const result = evaluatePublicLayeredFeasibility(input);
        expect(result.status).toBe("PASS");
        const { value, relaxed } = result;
        assert(value && relaxed, "Expected feasible and relaxed values");
        equivalent(value, oracle(input));
        expect(
          relaxed.worstAll.every((n, color) => {
            const pieces = input.stock[color];
            assert(pieces !== undefined, "Expected input stock coordinate");
            return n <= Math.floor(pieces / 10);
          }),
        ).toBe(true);
        checks++;
      }
    }
    expect(checks).toBe(24);
  });
  it("matches the old exact relaxation across all seven finite-coordinate shapes", () => {
    for (const finiteColors of [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]] as const) {
      const input = { ...request(), stock: [40, 40, 40] as const, finiteColors };
      const result = evaluatePublicLayeredFeasibility(input);
      const old = evaluatePublicPathRelaxationPair({
        ...input,
        beforeStock: input.stock,
        afterStock: input.stock,
      });
      expect(result.status).toBe("PASS");
      const { value, relaxed } = result;
      const before = old.before;
      assert(value && relaxed && before, "Expected matching relaxation values");
      expect(compareValue(value, before)).toBe(0);
      expect(
        value.consumed.every((n, color) => {
          const expected = before.consumed[color];
          assert(expected, "Expected reference consumption coordinate");
          return cmp(n, expected) === 0;
        }),
      ).toBe(true);
      expect(value.mask).toBe(before.mask);
      expect(value.chosen).toBe(before.chosen);
      expect(
        relaxed.worstAll.every((n, color) => {
          const worst = before.worst[color];
          assert(worst !== undefined, "Expected reference worst-use coordinate");
          return n >= worst;
        }),
      ).toBe(true);
    }
  });
});

describe("ALL-tied-optimal-policy stock feasibility boundaries", () => {
  it("proves feasible PBC and all action ties below the all-policy public depth", () => {
    const input = {
      ...request(),
      exp: 2600,
      stock: [10, 10, 10] as const,
      prices: [q(10), q(1), q(1)] as const,
      finiteColors: [],
    };
    const result = evaluatePublicLayeredFeasibility(input);
    const { plan, relaxed, value } = result;
    assert(plan && relaxed && value, "Expected admitted feasible result");
    expect(plan.rootDepth).toBe(2);
    expect(plan.feasibility.actualUses).toEqual([1, 1, 1]);
    expect(result.status).toBe("PASS");
    expect(relaxed.worstAll).toEqual([0, 1, 1]);
    expect(value.mask).toBe(6);
    equivalent(value, createOracleEvaluator(input.prices)(input));
  });
  it("rejects chosen-policy feasibility when another root-tied policy exceeds stock", () => {
    const input = {
      ...request(),
      exp: 2900,
      stock: [10, 0, 0] as const,
      prices: [q(1), q(1), q(1)] as const,
      finiteColors: [],
    };
    const old = evaluatePublicPathRelaxationPair({
      ...input,
      beforeStock: input.stock,
      afterStock: input.stock,
    });
    expect(old.beforeFits).toBe(true);
    const before = old.before;
    assert(before, "Expected chosen-policy endpoint");
    expect(before.worst).toEqual([1, 0, 0]);
    const result = evaluatePublicLayeredFeasibility(input);
    expect(result.status).toBe("UNKNOWN");
    expect(result.allOptimalPoliciesFit).toBe(false);
    expect(result.value).toBeNull();
    const relaxed = result.relaxed;
    assert(relaxed, "Expected infeasible relaxed policy");
    expect(relaxed.mask).toBe(7);
    expect(relaxed.worstAll).toEqual([1, 1, 1]);
    expect(createOracleEvaluator(input.prices)(input).ties).toEqual(["blue"]);
  });
  it("includes descendant action ties even when the relaxed root mask is singleton", () => {
    const input = {
      ...request(),
      stock: [10, 10, 0] as const,
      prices: [q(0), q(1), q(1)] as const,
      finiteColors: [0] as const,
    };
    const old = evaluatePublicPathRelaxationPair({
      ...input,
      beforeStock: input.stock,
      afterStock: input.stock,
    });
    expect(old.beforeFits).toBe(true);
    const before = old.before;
    assert(before, "Expected chosen-policy endpoint");
    expect(before.mask).toBe(1);
    expect(before.worst).toEqual([1, 1, 0]);
    const result = evaluatePublicLayeredFeasibility(input);
    expect(result.status).toBe("UNKNOWN");
    const relaxed = result.relaxed;
    assert(relaxed, "Expected descendant-tie relaxation");
    expect(relaxed.mask).toBe(1);
    expect(relaxed.worstAll).toEqual([1, 1, 1]);
    expect(result.value).toBeNull();
  });
  it("does not use expected consumption as a stock-feasibility certificate", () => {
    const unlimited = {
      ...request(),
      grade: "SR" as const,
      level: 0,
      exp: 0,
      stock: [100000, 0, 0] as const,
    };
    const baseline = evaluatePublicLayeredFeasibility(unlimited);
    expect(baseline.status).toBe("PASS");
    const { value, relaxed: baselineRelaxed } = baseline;
    assert(value && baselineRelaxed, "Expected unlimited baseline values");
    const expected = value.consumed[0];
    const uses = Number((expected.n + 10n * expected.d - 1n) / (10n * expected.d));
    expect(uses).toBeLessThan(baselineRelaxed.worstAll[0]);
    const result = evaluatePublicLayeredFeasibility({ ...unlimited, stock: [10 * uses, 0, 0] });
    const relaxed = result.relaxed;
    assert(relaxed, "Expected limited-stock relaxation");
    expect(cmp(relaxed.consumed[0], q(10 * uses))).toBeLessThanOrEqual(0);
    expect(result.status).toBe("UNKNOWN");
    expect(result.value).toBeNull();
  });
  it("keeps B equality until C and preserves exact terminal ties", () => {
    const input = {
      ...request(),
      exp: 2600,
      stock: [40, 10, 10] as const,
      prices: [q(10, 19), q(1000), q(1)] as const,
    };
    const result = evaluatePublicLayeredFeasibility(input);
    expect(result.status).toBe("PASS");
    const { value, relaxed } = result;
    assert(value && relaxed, "Expected exact tie-breaking values");
    expect(value.mask).toBe(4);
    expect(relaxed.worstAll).toEqual([0, 0, 1]);
    const ties = evaluatePublicLayeredFeasibility({
      ...input,
      exp: 2900,
      prices: [q(1), q(1), q(1)],
    });
    const { value: tiedValue, relaxed: tiedRelaxed } = ties;
    assert(tiedValue && tiedRelaxed, "Expected all-tied values");
    expect(tiedValue.mask).toBe(7);
    expect(tiedRelaxed.worstAll).toEqual([1, 1, 1]);
  });
});

describe("independent feasibility resource and status boundaries", () => {
  it("admits24 extra worst-use bytes per LIVE row and temporary reservation before allocation", () => {
    const input = request();
    const old = estimatePublicLayeredRelaxationPair({
      ...input,
      beforeStock: input.stock,
      afterStock: input.stock,
    });
    const plan = estimatePublicLayeredFeasibility(input);
    expect(plan.maximumRowBytes - old.maximumRowBytes).toBe(24);
    expect(plan.logicalUpperBytes - old.logicalUpperBytes).toBe(24 * (plan.maximumLiveRows + 40));
    expect(plan.limits).toEqual({ maxLiveRows: 125000, maxLogicalBytes: 160 * 1024 * 1024 });
    expect(() => JSON.stringify(plan)).not.toThrow();
  });
  it("retires finite layers within the upfront live reservation", () => {
    const result = evaluatePublicLayeredFeasibility({ ...request(), stock: [40, 40, 30] });
    expect(result.status).toBe("PASS");
    const plan = result.plan;
    assert(plan, "Expected admitted feasibility plan");
    expect(result.diagnostics.cumulativeRows).toBe(plan.cumulativeRows);
    expect(result.diagnostics.peakLiveRows).toBe(plan.maximumLiveRows);
    expect(result.diagnostics.cumulativeRows).toBeGreaterThan(result.diagnostics.peakLiveRows);
  });
  it("refuses live and byte admission before worktable allocation", () => {
    const rows = evaluatePublicLayeredFeasibility(request(), { maxLiveRows: 1 });
    expect(rows.status).toBe("NOTRUN");
    expect(rows.reason).toBe("public_feasibility_live_row_admission");
    expect(rows.diagnostics.cumulativeRows).toBe(0);
    const plan = estimatePublicLayeredFeasibility(request());
    const bytes = evaluatePublicLayeredFeasibility(request(), {
      maxLogicalBytes: plan.logicalUpperBytes - 1,
    });
    expect(bytes.status).toBe("NOTRUN");
    expect(bytes.reason).toBe("public_feasibility_logical_admission");
    expect(bytes.value).toBeNull();
    expect(bytes.diagnostics.cumulativeRows).toBe(0);
  });
  it("clamps ceilings downward and rejects invalid or unsupported inputs", () => {
    const plan = estimatePublicLayeredFeasibility(request(), {
      maxLiveRows: 1000000,
      maxLogicalBytes: 1024 * 1024 * 1024,
    });
    expect(plan.limits).toEqual({ maxLiveRows: 125000, maxLogicalBytes: 160 * 1024 * 1024 });
    const invalid = evaluatePublicLayeredFeasibility(request(), { maxLiveRows: 0 });
    expect(invalid.status).toBe("NOTRUN");
    expect(invalid.reason).toBe("public_feasibility_invalid_limits");
    const unsupported = evaluatePublicLayeredFeasibility({ ...request(), finiteColors: [0, 1, 2] });
    expect(unsupported.status).toBe("NOTRUN");
    expect(unsupported.reason).toBe("public_feasibility_requires_unlimited_color");
  });
  it("keeps an expired deadline authoritative before graph work", () => {
    const result = evaluatePublicLayeredFeasibility(request(), {
      deadlineAt: performance.now() - 1,
    });
    expect(result.status).toBe("NOTRUN");
    expect(result.reason).toBe("public_feasibility_deadline");
    expect(result.relaxed).toBeNull();
    expect(result.value).toBeNull();
  });
  it("keeps a final deadline authoritative despite computed relaxed fields", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      expect(evaluatePublicLayeredFeasibility(request()).status).toBe("PASS");
      const checks = clock.mock.calls.length;
      clock.mockClear();
      let calls = 0;
      clock.mockImplementation(() => (++calls >= checks - 1 ? 11000 : 0));
      const result = evaluatePublicLayeredFeasibility(request());
      expect(result.status).toBe("NOTRUN");
      expect(result.reason).toBe("public_feasibility_deadline");
      expect(result.relaxed).not.toBeNull();
      expect(result.value).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
  it("uses exact5000-bit prices without float conversion", () => {
    const tiny = q(1n, 1n << 5000n);
    const result = evaluatePublicLayeredFeasibility({
      ...request(),
      exp: 2900,
      prices: [tiny, q(1), q(2)],
    });
    expect(result.status).toBe("PASS");
    const { value, relaxed } = result;
    assert(value && relaxed, "Expected exact-price feasibility values");
    expect(cmp(value.B, q(10n, 1n << 5000n))).toBe(0);
    expect(relaxed.worstAll).toEqual([1, 0, 0]);
  });
  it("handles a terminal root and rejects sparse stock and finite-color tuples", () => {
    const terminal = evaluatePublicLayeredFeasibility({
      ...request(),
      level: 15,
      exp: 0,
      stock: [0, 0, 0],
    });
    expect(terminal.status).toBe("PASS");
    const { relaxed, value } = terminal;
    assert(relaxed && value, "Expected terminal feasibility values");
    expect(relaxed.worstAll).toEqual([0, 0, 0]);
    expect(value.mask).toBe(0);
    expect(terminal.diagnostics.cumulativeRows).toBe(0);
    const colors: (0 | 1 | 2)[] = [];
    colors.length = 1;
    expect(evaluatePublicLayeredFeasibility({ ...request(), finiteColors: colors }).status).toBe(
      "NOTRUN",
    );
    const sparse: [number, number, number] = [40, 0, 0];
    Reflect.deleteProperty(sparse, 1);
    expect(evaluatePublicLayeredFeasibility({ ...request(), stock: sparse }).reason).toBe(
      "public_feasibility_invalid_stock",
    );
  });
});
