import { describe, expect, it } from "vitest";

import { findReentrantActionPatterns, successIsMonotone } from "./monotonicity-screen";

describe("threshold-policy monotonicity screen", () => {
  it("detects an action that disappears and later returns", () => {
    expect(
      findReentrantActionPatterns([
        { availableUses: 0, action: "blue" },
        { availableUses: 1, action: "purple" },
        { availableUses: 2, action: "blue" },
      ]),
    ).toEqual([{ action: "blue", firstIndex: 0, gapIndex: 1, returnIndex: 2 }]);
  });

  it("checks the mathematically required nondecreasing reachability value", () => {
    expect(
      successIsMonotone([
        { successProbability: 0.2 },
        { successProbability: 0.2 },
        { successProbability: 0.3 },
      ]),
    ).toBe(true);
    expect(successIsMonotone([{ successProbability: 0.2 }, { successProbability: 0.19 }])).toBe(
      false,
    );
  });
});
