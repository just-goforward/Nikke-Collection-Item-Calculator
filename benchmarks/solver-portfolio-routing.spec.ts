import { describe, expect, it } from "vitest";
import {
  conditionalExactRescueEligible,
  portfolioRouteLatencyPassed,
} from "./solver-portfolio-routing-contract";

const start = { grade: "R" as const, level: 6, exp: 1000 };

describe("conditional exact-rescue routing", () => {
  it("matches only the pre-registered R low-level high-stock shape", () => {
    expect(
      conditionalExactRescueEligible({
        start,
        stock: { blue: 205, purple: 205, yellow: 205 },
      }),
    ).toBe(true);
    expect(
      conditionalExactRescueEligible({
        start,
        stock: { blue: 300, purple: 150, yellow: 150 },
      }),
    ).toBe(true);
    expect(
      conditionalExactRescueEligible({
        start,
        stock: { blue: 300, purple: 151, yellow: 151 },
      }),
    ).toBe(false);
    expect(
      conditionalExactRescueEligible({
        start,
        stock: { blue: 299, purple: 150, yellow: 150 },
      }),
    ).toBe(false);
  });

  it("rejects SR and levels above seven regardless of stock", () => {
    const stock = { blue: 300, purple: 150, yellow: 150 };
    expect(
      conditionalExactRescueEligible({
        start: { grade: "SR", level: 6, exp: 1000 },
        stock,
      }),
    ).toBe(false);
    expect(
      conditionalExactRescueEligible({
        start: { grade: "R", level: 8, exp: 1000 },
        stock,
      }),
    ).toBe(false);
  });

  it("uses the pre-registered relative-or-absolute latency gate", () => {
    expect(portfolioRouteLatencyPassed(100, 150)).toBe(true);
    expect(portfolioRouteLatencyPassed(100, 150.01)).toBe(false);
    expect(portfolioRouteLatencyPassed(1000, 1150)).toBe(true);
    expect(portfolioRouteLatencyPassed(1000, 1150.01)).toBe(false);
  });
});
