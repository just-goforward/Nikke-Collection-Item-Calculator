import { describe, expect, it } from "vitest";
import type { HpExactGateResult } from "./min-ef-hp-quality";
import {
  candidateContract,
  classifySharedProductGate,
  RESEARCH_CANDIDATES,
  runnableCandidates,
} from "./next-solver-research-contract";

describe("next solver research contract", () => {
  it("registers the ten algorithm families plus the WebGPU exact hybrid", () => {
    expect(RESEARCH_CANDIDATES).toHaveLength(11);
    expect(new Set(RESEARCH_CANDIDATES.map((candidate) => candidate.id)).size).toBe(11);
    expect(candidateContract("webgpu_compact_exact_hybrid").class).toBe("exact_product");
  });

  it("opens only candidates whose evidence prerequisites completed", () => {
    expect(runnableCandidates(new Set()).map((candidate) => candidate.id)).toEqual([
      "complete_policy_enumeration",
    ]);
    expect(
      runnableCandidates(new Set(["complete_policy_enumeration"])).map((candidate) => candidate.id),
    ).toEqual([
      "lp_column_generation_oracle",
      "webgpu_compact_exact_hybrid",
      "certified_limited_depth",
      "pareto_frontier_dp",
      "monotonicity_threshold_proof",
    ]);
  });

  it("requires exact, tail, performance, and strict-improvement evidence together", () => {
    const passed: HpExactGateResult = {
      status: "passed",
      violations: [],
      strictImprovement: true,
    };
    expect(
      classifySharedProductGate({
        exactGates: [passed],
        tailRiskPassed: true,
        hasStrictTailImprovement: false,
        performancePassed: true,
        hasNewFailure: false,
      }),
    ).toBe("product_candidate");
    expect(
      classifySharedProductGate({
        exactGates: [passed],
        tailRiskPassed: null,
        hasStrictTailImprovement: false,
        performancePassed: true,
        hasNewFailure: false,
      }),
    ).toBe("verification_incomplete");
  });
});
