import { describe, expect, it } from "vitest";

import { buildCompactStateGraph, solveCompactMinEf } from "./compact-exact-graph";
import { paretoPrune, solveParetoFrontiers } from "./pareto-frontier-dp";

describe("compact Pareto frontier DP", () => {
  it("removes componentwise dominated points without scalarizing kit preferences", () => {
    const points = paretoPrune([
      { action: "blue", successProbability: 0.9, vector: { blue: 10, purple: 10, yellow: 10 } },
      { action: "purple", successProbability: 0.9, vector: { blue: 20, purple: 10, yellow: 10 } },
      { action: "yellow", successProbability: 0.91, vector: { blue: 20, purple: 10, yellow: 10 } },
    ]);
    expect(points.map((point) => point.action)).toEqual(["yellow", "blue"]);
  });

  it("retains the compact min-E[f] root result on a small exact graph", () => {
    const built = buildCompactStateGraph(
      { grade: "SR", level: 10, exp: 2900 },
      { blue: 30, purple: 30, yellow: 30 },
    );
    if (built.outcome !== "completed") throw new Error("Pareto fixture graph did not complete.");
    const exact = solveCompactMinEf(built.graph).root;
    const pareto = solveParetoFrontiers(built.graph);
    if (pareto.outcome !== "completed")
      throw new Error("Pareto fixture exceeded its vector budget.");
    expect(
      pareto.root.some(
        (point) =>
          point.action === exact.action &&
          Math.abs(point.successProbability - exact.successProbability) <= 1e-12 &&
          Math.abs(point.vector.blue - exact.vector.blue) <= 1e-12 &&
          Math.abs(point.vector.purple - exact.vector.purple) <= 1e-12 &&
          Math.abs(point.vector.yellow - exact.vector.yellow) <= 1e-12,
      ),
    ).toBe(true);
  });

  it("fails closed when frontier products exceed the vector budget", () => {
    const built = buildCompactStateGraph(
      { grade: "SR", level: 10, exp: 2900 },
      { blue: 30, purple: 30, yellow: 30 },
    );
    if (built.outcome !== "completed") throw new Error("Pareto fixture graph did not complete.");
    expect(solveParetoFrontiers(built.graph, 8).outcome).toBe("vector_budget_exceeded");
  });
});
