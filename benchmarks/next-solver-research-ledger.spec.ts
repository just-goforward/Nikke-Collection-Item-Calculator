import { describe, expect, it } from "vitest";

import type { ResearchCandidateId } from "./next-solver-research-contract";
import {
  buildResearchDecisionLedger,
  type DirectCandidateEvidence,
} from "./next-solver-research-ledger";

describe("next solver research decision ledger", () => {
  it("stops dependent candidates when a prerequisite is rejected", () => {
    const evidence = new Map<ResearchCandidateId, DirectCandidateEvidence>([
      [
        "complete_policy_enumeration",
        {
          execution: "completed",
          grade: "verification_incomplete",
          prerequisitePassed: true,
          reason: "oracle passed",
          evidence: ["oracle"],
        },
      ],
      [
        "webgpu_compact_exact_hybrid",
        {
          execution: "completed",
          grade: "rejected",
          prerequisitePassed: false,
          reason: "capacity failed",
          evidence: ["webgpu"],
        },
      ],
    ]);
    const ledger = buildResearchDecisionLedger(evidence);
    const mcts = ledger.find((item) => item.id === "gpu_rollout_mcts");
    expect(mcts).toMatchObject({
      execution: "stopped_prerequisite",
      grade: "rejected",
      blockers: ["webgpu_compact_exact_hybrid"],
    });
  });

  it("keeps an unavailable offline oracle distinct from a rejected product candidate", () => {
    const evidence = new Map<ResearchCandidateId, DirectCandidateEvidence>([
      [
        "complete_policy_enumeration",
        {
          execution: "completed",
          grade: "verification_incomplete",
          prerequisitePassed: true,
          reason: "oracle passed",
          evidence: ["oracle"],
        },
      ],
      [
        "lp_column_generation_oracle",
        {
          execution: "failed",
          grade: "verification_incomplete",
          prerequisitePassed: false,
          reason: "solver unavailable",
          evidence: ["lp"],
        },
      ],
    ]);
    expect(
      buildResearchDecisionLedger(evidence).find(
        (item) => item.id === "lp_column_generation_oracle",
      ),
    ).toMatchObject({ execution: "failed", grade: "verification_incomplete" });
  });
});
