import { describe, expect, it } from "vitest";

import { buildCompactStateGraph } from "./compact-exact-graph";
import { exportMaximumReachabilityMps } from "./compact-lp-oracle";

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
    expect(first.variables).toBe(3);
    expect(first.flowRows).toBe(1);
    expect(first.text).toContain("OBJSENSE\n MAX");
    expect(first.text).toContain("NAME          tiny_policy");
    expect(first.text).toContain("RHS1      F0      1");
    expect(first.text.endsWith("ENDATA\n")).toBe(true);
  });
});
