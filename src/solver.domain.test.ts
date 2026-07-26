import { describe, expect, it } from "vitest";

import {
  convertState,
  MAX_RELEVANT_USES,
  memoKey,
  normalizeState,
  transition,
} from "./solver/domain";
import { solve } from "./solver/solve";

describe("solver transitions", () => {
  it("keeps level 0 as a valid starting state", () => {
    expect(normalizeState({ grade: "R", level: 0, exp: 0 })).toEqual({
      grade: "R",
      level: 0,
      exp: 0,
    });

    const result = solve(
      {
        stock: { blue: 100, purple: 0, yellow: 0 },
      },
      undefined,
    );
    expect(result.input?.start).toEqual({ grade: "R", level: 0, exp: 0 });
  });

  it("normalizes max level states without carrying extra exp", () => {
    expect(normalizeState({ grade: "R", level: 15, exp: 900 })).toEqual({
      grade: "R",
      level: 15,
      exp: 0,
    });
    expect(normalizeState({ grade: "SR", level: 99, exp: 2900 })).toEqual({
      grade: "SR",
      level: 15,
      exp: 0,
    });
  });

  it("converts R15 into SR5", () => {
    expect(convertState()).toEqual({ grade: "SR", level: 5, exp: 0 });
    const result = solve(
      {
        start: { grade: "R", level: 15, exp: 0 },
        stock: { blue: 0, purple: 0, yellow: 0 },
      },
      undefined,
    );
    expect(result.convertOnly).toBe(true);
    const best = result.best;
    expect(best).toBeDefined();
    if (!best) throw new Error("Expected conversion best action.");
    expect(best.firstAction).toBe("convert");
    expect(best.successProbability).toBe(1);
  });

  it("applies SR 10 purple transition probability and fail exp", () => {
    const result = transition({ grade: "SR", level: 10, exp: 0 }, "purple");
    expect(result.probability).toBeCloseTo(0.054, 6);
    expect(result.success).toEqual({ grade: "SR", level: 15, exp: 0 });
    expect(result.fail).toEqual({ grade: "SR", level: 10, exp: 500 });
  });

  it("applies level 0 great-success rates and transitions", () => {
    const rBlue = transition({ grade: "R", level: 0, exp: 0 }, "blue");
    expect(rBlue.probability).toBeCloseTo(0.176, 6);
    expect(rBlue.success).toEqual({ grade: "R", level: 5, exp: 0 });
    expect(rBlue.fail).toEqual({ grade: "R", level: 0, exp: 200 });

    const srYellow = transition({ grade: "SR", level: 0, exp: 0 }, "yellow");
    expect(srYellow.probability).toBeCloseTo(0.25, 6);
    expect(srYellow.success).toEqual({ grade: "SR", level: 5, exp: 0 });
    expect(srYellow.fail).toEqual({ grade: "SR", level: 0, exp: 1000 });
  });

  it("levels up from 0 to 1 through failed kit experience", () => {
    const result = transition({ grade: "R", level: 0, exp: 800 }, "blue");
    expect(result.fail).toEqual({ grade: "R", level: 1, exp: 0 });
  });

  it("maps out-of-range research stock to the explicit memo dimension cap", () => {
    const state = normalizeState({ grade: "R", level: 0, exp: 0 });
    const capped = memoKey(state, MAX_RELEVANT_USES);
    const outOfRange = memoKey(state, {
      blue: MAX_RELEVANT_USES.blue + 10_000,
      purple: MAX_RELEVANT_USES.purple + 10_000,
      yellow: MAX_RELEVANT_USES.yellow + 10_000,
    });
    const empty = memoKey(state, { blue: 0, purple: 0, yellow: 0 });

    expect(outOfRange).toBe(capped);
    expect(memoKey(state, { blue: -10, purple: -10, yellow: -10 })).toBe(empty);
    expect(capped).not.toBe(empty);
  });
});
