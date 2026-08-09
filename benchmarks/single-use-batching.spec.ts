import { describe, expect, it } from "vitest";
import { forceSingleUseBatching } from "./single-use-batching";

describe("single-use batching", () => {
  it("changes only a possible decision's run count", () => {
    const wrapped = forceSingleUseBatching(() => ({
      possible: true,
      best: { firstAction: "purple", probabilityGap: 0, run: { count: 5 } },
    }));
    expect(
      wrapped({
        start: { grade: "R", level: 10, exp: 0 },
        stock: { blue: 100, purple: 100, yellow: 100 },
        strategy: "supply",
      }),
    ).toEqual({
      possible: true,
      best: { firstAction: "purple", probabilityGap: 0, run: { count: 1 } },
    });
  });

  it("preserves impossible decisions", () => {
    const impossible = { possible: false, best: null } as const;
    const wrapped = forceSingleUseBatching(() => impossible);
    expect(
      wrapped({
        start: { grade: "SR", level: 15, exp: 0 },
        stock: { blue: 0, purple: 0, yellow: 0 },
        strategy: "supply",
      }),
    ).toBe(impossible);
  });
});
