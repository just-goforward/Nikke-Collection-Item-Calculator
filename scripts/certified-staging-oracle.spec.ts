import { describe, expect, it } from "vitest";
import {
  approx,
  cmp,
  compareValue,
  futureStockDistribution,
  independentFailure,
  q,
  solveOracle,
  ZERO,
} from "./certified-staging-oracle.ts";
import { solveIntegerOracle } from "./certified-staging-oracle-integer.ts";

describe("independent certified staging exact oracle", () => {
  it("checks the integer-denominator original-panel oracle against separate reduced-rational DP", () => {
    for (let index = 0; index < 31; index += 1) {
      const grade = index < 16 ? ("R" as const) : ("SR" as const);
      const level = index < 16 ? index : index - 16;
      const input = {
        grade,
        level,
        exp: level === 15 ? 0 : grade === "R" ? 900 : 2900,
        stock: [29, 27, 18] as const,
        prices: [q(7, 211), q(7, 203), q(7, 147)] as const,
      };
      const rational = solveOracle(input);
      const integer = solveIntegerOracle(input);
      expect([
        integer.P,
        integer.B,
        integer.C,
        integer.consumed,
        integer.action,
        integer.ties,
      ]).toEqual([
        rational.P,
        rational.B,
        rational.C,
        rational.consumed,
        rational.action,
        rational.ties,
      ]);
    }
  });
  it("preserves raw remainders and rejects consuming an impossible inventory", () => {
    const result = solveOracle({
      grade: "SR",
      level: 0,
      exp: 0,
      stock: [19, 9, 9],
      prices: [q(1, 19), q(1, 9), q(1, 9)],
    });
    expect(result.action).toBe("STOP");
    expect(result.P).toEqual(ZERO);
    expect(result.B).toEqual(ZERO);
    expect(result.C).toEqual(ZERO);
  });

  it("uses all three objective components and reports exact kit ties", () => {
    const tied = solveOracle({
      grade: "SR",
      level: 14,
      exp: 2900,
      stock: [10, 10, 10],
      prices: [q(1, 10), q(1, 10), q(1, 10)],
    });
    expect(tied.action).toBe("blue");
    expect(tied.ties).toEqual(["blue", "purple", "yellow"]);
    expect(tied.P).toEqual(q(1));
    expect(tied.B).toEqual(q(1));
    expect(tied.C).toEqual(q(10));
    const weighted = solveOracle({
      grade: "SR",
      level: 14,
      exp: 2900,
      stock: [10, 10, 10],
      prices: [q(1, 11), q(1, 12), q(1, 13)],
    });
    expect(weighted.action).toBe("yellow");
    expect(weighted.B).toEqual(q(10, 13));
  });

  it("retains costs on failure branches of the selected two-use policy", () => {
    const result = solveOracle({
      grade: "SR",
      level: 13,
      exp: 0,
      stock: [20, 0, 0],
      prices: [q(1, 20), q(1), q(1)],
    });
    // 4.7% at SR13, then 4.7% after ordinary blue EXP; both failures still consume.
    expect(result.P).toEqual(q(91_791, 1_000_000));
    expect(result.B).toEqual(q(1953, 2000));
    expect(result.C).toEqual(q(1953, 100));
  });

  it("discards ordinary EXP at stage boundaries and canonically converts R15", () => {
    expect(independentFailure("R", 4, 900, 2)).toEqual({ grade: "R", level: 5, exp: 0 });
    expect(independentFailure("SR", 9, 2900, 2)).toEqual({ grade: "SR", level: 10, exp: 0 });
    expect(independentFailure("R", 14, 900, 0)).toEqual({ grade: "SR", level: 5, exp: 0 });
  });

  it("distinguishes exact probability and cost gaps hidden by floats", () => {
    const a = q(1);
    const b = q((1n << 54n) + 1n, 1n << 54n);
    expect(approx(a)).toBe(approx(b));
    expect(cmp(a, b)).toBe(-1);
    expect(compareValue({ P: a, B: ZERO, C: ZERO }, { P: b, B: ZERO, C: ZERO })).toBe(-1);
    expect(compareValue({ P: a, B: a, C: ZERO }, { P: a, B: b, C: ZERO })).toBe(1);
    expect(compareValue({ P: a, B: a, C: a }, { P: a, B: a, C: b })).toBe(1);
  });

  it("keeps one latent dispatch cohort across future events", () => {
    const gain = { stock: [10, 0, 0] as const, probability: q(1) };
    const empty = { stock: [0, 0, 0] as const, probability: q(1) };
    const byCohort = [[gain], [empty], [empty]] as const;
    const distribution = futureStockDistribution(
      [0, 0, 0],
      [
        { day: 1, byCohort },
        { day: 2, byCohort },
      ],
      2,
      [q(1, 2), q(1, 2), ZERO],
    );
    expect(distribution).toEqual([
      { stock: [20, 0, 0], probability: q(1, 2) },
      { stock: [0, 0, 0], probability: q(1, 2) },
    ]);
  });
});
