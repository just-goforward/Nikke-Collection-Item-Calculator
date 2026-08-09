import { describe, expect, it } from "vitest";

import { buildCompactStateGraph, solveCompactMinEf } from "./compact-exact-graph";
import { screenExactSymbolicCompression } from "./symbolic-compression-screen";

describe("exact symbolic compression screen", () => {
  it("groups only structurally and bit-value identical compact states", () => {
    const built = buildCompactStateGraph(
      { grade: "SR", level: 10, exp: 2900 },
      { blue: 30, purple: 30, yellow: 30 },
    );
    if (built.outcome !== "completed") throw new Error("Symbolic fixture graph did not complete.");
    const screen = screenExactSymbolicCompression(built.graph, solveCompactMinEf(built.graph));
    expect(screen.nodes).toBe(built.graph.nodes.length);
    expect(screen.uniquePartitions).toBeLessThanOrEqual(screen.nodes);
    expect(screen.exactValueMismatches).toBe(0);
    expect(screen.reduction).toBeGreaterThanOrEqual(0);
  });
});
