import { expect, it } from "vitest";
import { type OracleInput, type OracleResult, q, solveOracle } from "./certified-staging-oracle.ts";
import { independentLargeCappedOracle } from "./certified-staging-oracle-large-capped.ts";
import { independentLargeIntegerOracle } from "./certified-staging-oracle-large-integer.ts";
import { independentLayeredOracle } from "./certified-staging-oracle-layered.ts";
import { createIndependentPublicCaps } from "./certified-staging-oracle-public-caps.ts";

function comparable(value: OracleResult) {
  return [value.P, value.B, value.C, value.consumed, value.action, value.ties];
}
it("crosschecks the separately admitted large integer oracle against reduced rational Bellman arithmetic", () => {
  for (const grade of ["R", "SR"] as const) {
    for (const level of [0, 4, 5, 9, 10, 14, 15]) {
      const input: OracleInput = {
        grade,
        level,
        exp: level === 15 ? 0 : grade === "R" ? 900 : 2900,
        stock: [39, 27, 18],
        prices: [q(7, 211), q(7, 203), q(7, 147)],
      };
      const result = independentLargeIntegerOracle(input, { maxMemoEntries: 50000, check() {} });
      expect(comparable(result)).toEqual(comparable(solveOracle(input)));
      expect(
        comparable(independentLargeCappedOracle(input, { maxMemoEntries: 50000, check() {} })),
      ).toEqual(comparable(result));
      expect(
        comparable(independentLayeredOracle(input, { maxMemoEntries: 50000, check() {} })),
      ).toEqual(comparable(result));
    }
  }
});
it("derives all-policy bounds including every positive-mass outcome and lifts discarded units exactly", () => {
  const input: OracleInput = {
    grade: "SR",
    level: 14,
    exp: 2900,
    stock: [600, 200, 100],
    prices: [q(1, 610), q(1, 210), q(1, 110)],
  };
  expect(createIndependentPublicCaps().bounds(input)).toEqual([1, 1, 1]);
  const limits = { maxMemoEntries: 50000, check() {} };
  expect(comparable(independentLargeCappedOracle(input, limits))).toEqual(
    comparable(independentLargeIntegerOracle(input, limits)),
  );
});
it("preserves exact kit ties and independently aborts before allocating over admitted memo count", () => {
  const input: OracleInput = {
    grade: "SR",
    level: 14,
    exp: 2900,
    stock: [10, 10, 10],
    prices: [q(1, 10), q(1, 10), q(1, 10)],
  };
  expect(independentLargeIntegerOracle(input, { maxMemoEntries: 100, check() {} }).ties).toEqual([
    "blue",
    "purple",
    "yellow",
  ]);
  expect(() => independentLargeIntegerOracle(input, { maxMemoEntries: 0, check() {} })).toThrow(
    "large_oracle_memo_admission_limit",
  );
});
