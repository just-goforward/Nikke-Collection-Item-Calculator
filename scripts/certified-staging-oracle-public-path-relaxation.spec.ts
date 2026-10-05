import { describe, expect, it } from "vitest";
import {
  cmp,
  compareValue,
  createOracleEvaluator,
  type QTriple,
  q,
} from "./certified-staging-oracle.ts";
import {
  estimatePublicPathRelaxationPair,
  evaluatePublicPathRelaxationPair,
  type PublicPathRelaxationInput,
} from "./certified-staging-oracle-public-path-relaxation.ts";

const FINITE_SETS = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]] as const;
function input(): PublicPathRelaxationInput {
  return {
    grade: "SR",
    level: 14,
    exp: 2400,
    prices: [q(1), q(2), q(4)],
    beforeStock: [0, 40, 40],
    afterStock: [10, 40, 40],
    finiteColors: [0, 2],
  };
}
describe("independent public-game semi-infinite recurrence", () => {
  it("matches the reduced rational public oracle for all seven finite-color sets and three price families", () => {
    const families: readonly QTriple[] = [
      [q(1), q(2), q(4)],
      [q(10, 19), q(1000), q(1)],
      [q(1), q(1), q(1)],
    ];
    let checks = 0;
    for (const prices of families) {
      const oracle = createOracleEvaluator(prices);
      for (const finiteColors of FINITE_SETS) {
        const request = { ...input(), prices, finiteColors };
        const result = evaluatePublicPathRelaxationPair(request);
        expect(result.status).not.toBe("NOTRUN");
        expect(result.plan?.rootDepth).toBe(3);
        for (const endpoint of ["before", "after"] as const) {
          const actual = result[endpoint];
          if (!actual) throw new Error("Expected exact relaxed endpoint");
          const stock = request[`${endpoint}Stock`].map((pieces, color) =>
            finiteColors.some((finite) => finite === color) ? pieces : 40,
          ) as [number, number, number];
          // Four reference uses exceed every public path's depth=3. Therefore
          // this uncapped finite oracle implements exactly the relaxed action set.
          const reference = oracle({
            grade: request.grade,
            level: request.level,
            exp: request.exp,
            stock,
          });
          expect(compareValue(actual, reference)).toBe(0);
          expect(
            actual.consumed.every((value, color) => cmp(value, reference.consumed[color]!) === 0),
          ).toBe(true);
          checks++;
        }
      }
    }
    expect(checks).toBe(42);
  });
  it("requires both selected policies to fit for both finite endpoint equalities", () => {
    const result = evaluatePublicPathRelaxationPair(input());
    expect(result.status).toBe("PASS_ENDPOINTS_EQUALITY");
    expect(result.beforeFits && result.afterFits).toBe(true);
    expect(result.strictOrder).toBe(1);
    expect(result.before?.worst).toEqual([0, 2, 0]);
    expect(result.after?.worst).toEqual([1, 1, 0]);
  });
  it("reports N-only when the before upper bound is infeasible but the after policy fits", () => {
    const request = {
      ...input(),
      beforeStock: [0, 0, 0] as const,
      afterStock: [10, 10, 0] as const,
    };
    const result = evaluatePublicPathRelaxationPair(request);
    expect(result.status).toBe("PASS_N_ONLY");
    expect(result.beforeFits).toBe(false);
    expect(result.afterFits).toBe(true);
    const oracle = createOracleEvaluator(request.prices);
    const before = oracle({ ...request, stock: request.beforeStock });
    const after = oracle({ ...request, stock: request.afterStock });
    expect(compareValue(after, before)).toBe(1);
    expect(cmp(result.before!.P, before.P)).toBe(1);
    expect(compareValue(result.after!, after)).toBe(0);
  });
  it("returns UNKNOWN when selected unlimited-color demand exceeds actual after stock", () => {
    const result = evaluatePublicPathRelaxationPair({
      ...input(),
      beforeStock: [0, 0, 0],
      afterStock: [10, 0, 0],
    });
    expect(result.strictOrder).toBe(1);
    expect(result.after?.worst[1]).toBe(1);
    expect(result.afterFits).toBe(false);
    expect(result.status).toBe("UNKNOWN");
    expect(result.reason).toBe("independent_public_relaxation_after_policy_infeasible");
  });
  it("keeps exact endpoint ties UNKNOWN", () => {
    const result = evaluatePublicPathRelaxationPair({
      ...input(),
      beforeStock: [40, 40, 40],
      afterStock: [40, 40, 40],
    });
    expect(result.beforeFits && result.afterFits).toBe(true);
    expect(result.strictOrder).toBe(0);
    expect(result.status).toBe("UNKNOWN");
  });
  it("uses C to break an exact P/B tie and keeps equal-value action masks", () => {
    const request = {
      ...input(),
      exp: 2600,
      prices: [q(10, 19), q(1000), q(1)] as const,
      beforeStock: [20, 10, 10] as const,
      afterStock: [20, 10, 10] as const,
    };
    const cTie = evaluatePublicPathRelaxationPair(request);
    expect(cTie.before?.chosen).toBe(2);
    expect(cTie.before?.mask).toBe(4);
    expect(cmp(cTie.before!.B, q(10))).toBe(0);
    expect(cmp(cTie.before!.C, q(10))).toBe(0);
    const allTies = evaluatePublicPathRelaxationPair({
      ...request,
      exp: 2900,
      prices: [q(1), q(1), q(1)],
    });
    expect(allTies.before?.mask).toBe(7);
    expect(allTies.before?.chosen).toBe(0);
  });
});

describe("independent public-game pre-allocation admission", () => {
  it("exposes the original24 public domain and finite inventory widths without any worktable", () => {
    const plan = estimatePublicPathRelaxationPair(
      {
        ...input(),
        grade: "R",
        exp: 900,
        beforeStock: [153, 398, 112],
        afterStock: [221, 398, 112],
        finiteColors: [2, 0],
      },
      { maxRows: 125_000 },
    );
    expect(plan.reachablePublicNodes).toBe(298);
    expect(plan.rootDepth).toBe(151);
    expect(plan.finiteColors).toEqual([0, 2]);
    expect(plan.finiteWidths).toEqual([23, 1, 12]);
    expect(plan.maxRows).toBe(82_248);
    expect(plan.maxKey).toBe(82_247);
    expect(plan.admitted).toBe(true);
    expect(plan.admittedLogicalUpperBytes).toBeLessThan(160 * 1024 * 1024);
    expect(() => JSON.stringify(plan)).not.toThrow();
  });
  it("rejects a real rectangular row overrun before any memo row is allocated", () => {
    const result = evaluatePublicPathRelaxationPair(input(), { maxRows: 1 });
    expect(result.plan?.admitted).toBe(false);
    expect(result.status).toBe("NOTRUN");
    expect(result.reason).toBe("independent_public_relaxation_row_admission");
    expect(result.rawException?.message).toBe(result.reason);
    expect(result.before).toBeNull();
    expect(result.diagnostics.memoRows).toBe(0);
  });
  it("rejects a logical byte overrun after small graph planning but before the worktable", () => {
    const plan = estimatePublicPathRelaxationPair(input());
    const maxLogicalBytes = plan.logicalBreakdown.graph + 128;
    const result = evaluatePublicPathRelaxationPair(input(), { maxLogicalBytes });
    expect(result.plan?.admittedLogicalUpperBytes).toBeGreaterThan(maxLogicalBytes);
    expect(result.reason).toBe("independent_public_relaxation_logical_admission");
    expect(result.diagnostics.memoRows).toBe(0);
  });
  it("uses only exact arithmetic for prices beyond binary64's finite exponent range", () => {
    const tiny = q(1n, 1n << 5000n);
    const result = evaluatePublicPathRelaxationPair({
      ...input(),
      exp: 2900,
      beforeStock: [10, 10, 10],
      afterStock: [10, 10, 10],
      prices: [tiny, q(1), q(2)],
    });
    expect(result.before?.chosen).toBe(0);
    expect(cmp(result.before!.B, q(10n, 1n << 5000n))).toBe(0);
  });
  it("records an expired deadline and an unsafe index domain as NOTRUN", () => {
    const timed = evaluatePublicPathRelaxationPair(input(), { deadlineAt: performance.now() - 1 });
    expect(timed.reason).toBe("independent_public_relaxation_deadline");
    expect(timed.diagnostics.memoRows).toBe(0);
    const unsafe = evaluatePublicPathRelaxationPair({
      ...input(),
      afterStock: [Number.MAX_SAFE_INTEGER, 40, Number.MAX_SAFE_INTEGER],
    });
    expect(unsafe.reason).toBe("independent_public_relaxation_numeric_key_domain");
    expect(unsafe.diagnostics.memoRows).toBe(0);
  });
  it("refuses an all-finite selection instead of assuming P=1", () => {
    const result = evaluatePublicPathRelaxationPair({ ...input(), finiteColors: [0, 1, 2] });
    expect(result.status).toBe("NOTRUN");
    expect(result.reason).toBe("independent_public_relaxation_requires_unlimited_color");
  });
});
