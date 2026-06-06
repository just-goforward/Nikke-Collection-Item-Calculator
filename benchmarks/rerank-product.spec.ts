import { describe, expect, it } from "vitest";
import { PRODUCT_RERANK_SCENARIOS } from "./scenarios/rerank-product";

describe("product-observed rerank scenarios", () => {
  it("covers observed purple/yellow stock bands without treating high-stock cases as core", () => {
    const byId = new Map(PRODUCT_RERANK_SCENARIOS.map((scenario) => [scenario.id, scenario]));

    expect(byId.get("R0-observedCore")?.stock).toEqual({ blue: 300, purple: 150, yellow: 70 });
    expect(byId.get("SR10-observedYellowLow")?.stock).toEqual({
      blue: 300,
      purple: 150,
      yellow: 30,
    });
    expect(byId.get("SR10-observedPurpleHigh")).toMatchObject({
      productSource: "product-observed-high-stock",
      stock: { blue: 350, purple: 300, yellow: 150 },
    });
    expect([...byId.values()].some((scenario) => scenario.stock.yellow >= 300)).toBe(false);
    expect(
      [...byId.values()].some(
        (scenario) =>
          scenario.productSource === "product-observed" &&
          (scenario.stock.purple >= 300 || scenario.stock.yellow >= 300),
      ),
    ).toBe(false);
  });

  it("includes early and late journey states for runtime and value weighting", () => {
    expect(PRODUCT_RERANK_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "R0-observedCore",
      "SR0-observedCore",
      "SR5-observedCore",
      "SR10-observedCore",
      "R0-observedBalanced",
      "SR0-observedBalanced",
      "SR10-observedBalanced",
      "SR0-observedPurpleHigh",
      "SR5-observedPurpleHigh",
      "SR10-observedPurpleHigh",
      "SR14e2900-observedPurpleHigh",
      "R0-observedYellowLow",
      "SR0-observedYellowLow",
      "SR5-observedYellowLow",
      "SR10-observedYellowLow",
      "R0-observedLowKits",
      "SR0-observedLowKits",
      "SR10-observedLowKits",
    ]);
  });
});
