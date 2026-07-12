import { describe, expect, it } from "vitest";
import { failAfterUses, failOnce, greatSuccessState } from "../../shared/game";

describe("worker domain transitions", () => {
  it("moves great success to the next 5-level boundary", () => {
    expect(greatSuccessState({ grade: "R", level: 3, exp: 400 })).toEqual({
      grade: "R",
      level: 5,
      exp: 0,
    });
    expect(greatSuccessState({ grade: "SR", level: 11, exp: 1000 })).toEqual({
      grade: "SR",
      level: 15,
      exp: 0,
    });
  });

  it("advances failed attempts by kit exp and stops at segment boundaries", () => {
    expect(failOnce({ grade: "R", level: 4, exp: 800 }, "blue")).toEqual({
      grade: "R",
      level: 5,
      exp: 0,
    });
    expect(failAfterUses({ grade: "SR", level: 10, exp: 0 }, "yellow", 3)).toEqual({
      grade: "SR",
      level: 11,
      exp: 0,
    });
  });
});
