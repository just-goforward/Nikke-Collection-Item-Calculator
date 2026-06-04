import { describe, expect, it } from "vitest";
import { RERANK_SUPPLEMENTAL_SCENARIOS } from "./scenarios/rerank-supplemental";

describe("rerank supplemental scenarios", () => {
  it("covers gain28 third, half, and one without gain28 two", () => {
    expect(RERANK_SUPPLEMENTAL_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "R0-gain28Third",
      "SR0-gain28Third",
      "R0-gain28Half",
      "SR0-gain28Half",
      "R0-gain28One",
      "SR0-gain28One",
      "SR10-gain28One",
      "SR14e2900-gain28One",
    ]);
  });

  it("uses 10-piece rounded monthly gain stocks", () => {
    const byId = new Map(
      RERANK_SUPPLEMENTAL_SCENARIOS.map((scenario) => [scenario.id, scenario.stock]),
    );

    expect(byId.get("R0-gain28Third")).toEqual({ blue: 160, purple: 20, yellow: 10 });
    expect(byId.get("R0-gain28Half")).toEqual({ blue: 240, purple: 30, yellow: 10 });
    expect(byId.get("R0-gain28One")).toEqual({ blue: 470, purple: 60, yellow: 20 });
  });
});
