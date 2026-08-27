import { describe, expect, it } from "vitest";

import { availabilityCostScore, researchCostScore } from "./cost";

describe("availability cost forecast context", () => {
  it("uses the supplied gain vector for product and research availability costs", () => {
    const vector = { blue: 30, purple: 12, yellow: 6 };
    const stock = { blue: 100, purple: 100, yellow: 100 };
    const lowGain = { blue: 10, purple: 10, yellow: 10 };
    const highGain = { blue: 100, purple: 100, yellow: 100 };

    const low = availabilityCostScore(vector, stock, lowGain);
    const high = availabilityCostScore(vector, stock, highGain);

    expect(high).toBeLessThan(low);
    expect(
      researchCostScore(vector, stock, {
        kind: "availability-pnorm",
        expectedGain: highGain,
      }),
    ).toBe(high);
  });
});
