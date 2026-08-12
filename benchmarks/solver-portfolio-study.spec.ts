import { describe, expect, it } from "vitest";
import {
  type PortfolioSemantic,
  preRegisteredExactRescueArm,
  rootLatencyLimitMs,
  semanticParity,
  shouldScreenPortfolioAlternatives,
} from "./solver-portfolio-study.ts";

const SEMANTIC: PortfolioSemantic = {
  action: "purple",
  expectedCost: 0.25,
  maxSuccessProbability: 0.8,
  successProbability: 0.8,
  vector: { blue: 10, purple: 20, yellow: 30 },
};

describe("solver portfolio research contract", () => {
  it("screens alternatives only after a capacity outcome", () => {
    expect(shouldScreenPortfolioAlternatives("memo_full")).toBe(true);
    expect(shouldScreenPortfolioAlternatives("budget_exceeded")).toBe(true);
    expect(shouldScreenPortfolioAlternatives("completed")).toBe(false);
    expect(shouldScreenPortfolioAlternatives("failure")).toBe(false);
    expect(shouldScreenPortfolioAlternatives("timeout")).toBe(false);
  });

  it("keeps the exact-rescue routing hypothesis fixed by grade", () => {
    expect(preRegisteredExactRescueArm({ start: { grade: "R", level: 0, exp: 0 } })).toBe(
      "min-ef-tier22",
    );
    expect(preRegisteredExactRescueArm({ start: { grade: "SR", level: 0, exp: 0 } })).toBe(
      "branch-bound-b2-tier22",
    );
  });

  it("compares exact semantics component-wise and by f64 bits", () => {
    expect(semanticParity(SEMANTIC, structuredClone(SEMANTIC))).toBe(true);
    expect(
      semanticParity(SEMANTIC, {
        ...SEMANTIC,
        vector: { ...SEMANTIC.vector, yellow: 30 + Number.EPSILON * 30 },
      }),
    ).toBe(false);
    expect(semanticParity(SEMANTIC, null)).toBe(false);
  });

  it("uses the larger relative-or-absolute latency allowance", () => {
    expect(rootLatencyLimitMs(100)).toBe(150);
    expect(rootLatencyLimitMs(1000)).toBe(1150);
  });
});
