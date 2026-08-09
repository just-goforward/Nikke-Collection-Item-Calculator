import { describe, expect, it } from "vitest";

import { solveCertifiedLimitedDepth } from "./certified-limited-depth";
import { buildCompactStateGraph, solveCompactMinEf } from "./compact-exact-graph";

describe("certified limited-depth min-E[f]", () => {
  it("contains the exact compact value at every shallow interval", () => {
    const start = { grade: "SR" as const, level: 10, exp: 2900 };
    const stock = { blue: 30, purple: 30, yellow: 30 };
    const graph = buildCompactStateGraph(start, stock);
    if (graph.outcome !== "completed") throw new Error("Exact fixture graph did not complete.");
    const exact = solveCompactMinEf(graph.graph).root;
    for (const depthLimit of [0, 1, 2]) {
      const bounded = solveCertifiedLimitedDepth({ start, stock, depthLimit });
      expect(bounded.root.successLower).toBeLessThanOrEqual(exact.maxSuccessProbability + 1e-12);
      expect(bounded.root.successUpper).toBeGreaterThanOrEqual(exact.maxSuccessProbability - 1e-12);
      expect(bounded.root.costLower).toBeLessThanOrEqual(exact.expectedCost + 1e-12);
      expect(bounded.root.costUpper).toBeGreaterThanOrEqual(exact.expectedCost - 1e-12);
    }
  });

  it("certifies a late fixture once the complete continuation fits inside the depth", () => {
    const result = solveCertifiedLimitedDepth({
      start: { grade: "SR", level: 14, exp: 2900 },
      stock: { blue: 10, purple: 10, yellow: 10 },
      depthLimit: 1,
    });
    expect(result.outcome).toBe("completed");
    expect(result.selectedAction).not.toBeNull();
  });

  it("reports ambiguity instead of publishing an uncertified shallow action", () => {
    const result = solveCertifiedLimitedDepth({
      start: { grade: "R", level: 10, exp: 0 },
      stock: { blue: 300, purple: 300, yellow: 300 },
      depthLimit: 1,
    });
    expect(result.outcome).toBe("numeric_ambiguous");
    expect(result.selectedAction).toBeNull();
  });

  it("fails closed at the state budget", () => {
    const result = solveCertifiedLimitedDepth({
      start: { grade: "R", level: 10, exp: 0 },
      stock: { blue: 300, purple: 300, yellow: 300 },
      depthLimit: 8,
      stateBudget: 8,
    });
    expect(result.outcome).toBe("budget_exceeded");
    expect(result.selectedAction).toBeNull();
  });
});
