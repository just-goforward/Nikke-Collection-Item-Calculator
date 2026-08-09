import { describe, expect, it } from "vitest";

import { buildCompactStateGraph } from "./compact-exact-graph";
import {
  exportCompactOccupancyMps,
  exportMaximumReachabilityMps,
  parseHighsSolution,
  rootActionFromSolution,
} from "./compact-lp-oracle";

describe("compact LP oracle export", () => {
  it("writes a deterministic maximum-reachability occupancy model", () => {
    const built = buildCompactStateGraph(
      { grade: "SR", level: 14, exp: 2900 },
      { blue: 10, purple: 10, yellow: 10 },
    );
    if (built.outcome !== "completed") throw new Error("Tiny LP fixture did not complete.");
    const first = exportMaximumReachabilityMps(built.graph, "tiny-policy");
    const second = exportMaximumReachabilityMps(built.graph, "tiny-policy");
    expect(first).toEqual(second);
    expect(first.variables).toHaveLength(3);
    expect(first.flowRows).toBe(1);
    expect(first.text).toContain("OBJSENSE\n MAX");
    expect(first.text).toContain("NAME          tiny_policy");
    expect(first.text).toContain("RHS1      F0      1");
    expect(first.text.endsWith("ENDATA\n")).toBe(true);
  });

  it("writes lexicographic cost and total-use stages with explicit caps", () => {
    const built = buildCompactStateGraph(
      { grade: "SR", level: 14, exp: 2900 },
      { blue: 10, purple: 10, yellow: 10 },
    );
    if (built.outcome !== "completed") throw new Error("Tiny LP fixture did not complete.");
    const cost = exportCompactOccupancyMps(
      built.graph,
      "minimum_expected_cost",
      { minimumReachability: 1 - 1e-10 },
      "tiny-cost",
    );
    const uses = exportCompactOccupancyMps(
      built.graph,
      "minimum_expected_uses",
      { minimumReachability: 1 - 1e-10, maximumExpectedCost: 0.25 },
      "tiny-uses",
    );
    expect(cost.text).toContain("OBJSENSE\n MIN");
    expect(cost.text).toContain(" G  REACH");
    expect(uses.text).toContain(" L  COSTCAP");
    expect(uses.variables.every((variable) => variable.expectedUsesCoefficient === 10)).toBe(true);
  });

  it("combines flow coefficients when canonical success and failure share a target", () => {
    const built = buildCompactStateGraph(
      { grade: "R", level: 14, exp: 900 },
      { blue: 10, purple: 10, yellow: 10 },
    );
    if (built.outcome !== "completed") throw new Error("R15 conversion fixture did not complete.");
    const model = exportMaximumReachabilityMps(built.graph);
    const columnSection = model.text.split("COLUMNS\n")[1]?.split("RHS\n")[0] ?? "";
    const pairs = columnSection
      .trim()
      .split(/\r?\n/u)
      .map((line) => {
        const [variable, row] = line.trim().split(/\s+/u);
        return `${variable}:${row}`;
      });
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("parses raw HiGHS solutions and resolves the occupied root action", () => {
    const built = buildCompactStateGraph(
      { grade: "SR", level: 14, exp: 2900 },
      { blue: 10, purple: 10, yellow: 10 },
    );
    if (built.outcome !== "completed") throw new Error("Tiny LP fixture did not complete.");
    const model = exportMaximumReachabilityMps(built.graph);
    const parsed = parseHighsSolution(`Model status
Optimal

# Primal solution values
Feasible
Objective 1
# Columns 3
X0_0 0
X0_1 1
X0_2 0
# Rows 1
F0 1
`);
    expect(parsed.modelStatus).toBe("Optimal");
    expect(parsed.primalStatus).toBe("Feasible");
    expect(parsed.objective).toBe(1);
    expect(rootActionFromSolution(built.graph, model, parsed)).toBe("purple");
  });
});
