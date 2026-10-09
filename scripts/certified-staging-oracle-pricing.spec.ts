import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { CertifiedInput, CertifiedOutput } from "../src/certified/types.ts";
import { q, wire } from "./certified-staging-oracle.ts";
import { verifyPhysicalPricing } from "./certified-staging-oracle-pricing.ts";

function fixture() {
  return JSON.parse(
    readFileSync("scripts/certified-staging-oracle-fixtures/paged-R600-fullH.json.txt", "utf8"),
  ) as {
    input: CertifiedInput;
    output: CertifiedOutput;
  };
}
it("checks documented physical prices independently and detects altered rates even when all current P/B/C vanish", () => {
  const { input, output } = fixture();
  expect(verifyPhysicalPricing(output, input.stock).status).toBe("PASS");
  const zero = wire(q(0));
  const { current, pricing } = output;
  assert(current && pricing, "Expected current optimum and physical pricing");
  current.value = {
    successP: zero,
    weightedExpectedConsumptionB: zero,
    expectedTotalConsumptionC: zero,
    expectedConsumed: [zero, zero, zero],
    display: { successP: 0, weightedExpectedConsumptionB: 0, expectedTotalConsumptionC: 0 },
  };
  const rate = pricing.recurringRate[0];
  pricing.recurringRate = [
    { ...rate, numerator: String(BigInt(rate.numerator) + 1n) },
    pricing.recurringRate[1],
    pricing.recurringRate[2],
  ];
  expect(verifyPhysicalPricing(output, input.stock)).toEqual({
    status: "FAIL",
    failures: ["recurring_rate_0"],
  });
});
it("separates missing pricing from verified pricing instead of treating a refused request as a passed contract", () => {
  const { input, output } = fixture();
  output.pricing = null;
  expect(verifyPhysicalPricing(output, input.stock).status).toBe("FAIL");
  output.current = null;
  expect(verifyPhysicalPricing(output, input.stock).status).toBe("NOTRUN");
});
