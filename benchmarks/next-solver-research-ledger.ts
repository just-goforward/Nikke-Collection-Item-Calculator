import {
  RESEARCH_CANDIDATES,
  type ResearchCandidateId,
  type ResearchGrade,
} from "./next-solver-research-contract.ts";

export type DirectCandidateEvidence = {
  execution: "completed" | "failed";
  grade: ResearchGrade;
  prerequisitePassed: boolean;
  reason: string;
  evidence: string[];
};

export type ResearchDecision = Omit<DirectCandidateEvidence, "execution"> & {
  id: ResearchCandidateId;
  priority: number;
  execution: "completed" | "failed" | "stopped_prerequisite";
  blockers: ResearchCandidateId[];
};

export function buildResearchDecisionLedger(
  directEvidence: ReadonlyMap<ResearchCandidateId, DirectCandidateEvidence>,
): ResearchDecision[] {
  const decisions = new Map<ResearchCandidateId, ResearchDecision>();
  for (const candidate of [...RESEARCH_CANDIDATES].sort(
    (left, right) => left.priority - right.priority,
  )) {
    const direct = directEvidence.get(candidate.id);
    if (direct) {
      decisions.set(candidate.id, {
        id: candidate.id,
        priority: candidate.priority,
        ...direct,
        blockers: [],
      });
      continue;
    }
    const blockers = candidate.prerequisites.filter((id) => {
      const dependency = decisions.get(id);
      return !dependency?.prerequisitePassed;
    });
    if (blockers.length === 0) {
      decisions.set(candidate.id, {
        id: candidate.id,
        priority: candidate.priority,
        execution: "failed",
        grade: "verification_incomplete",
        prerequisitePassed: false,
        reason: "No direct evidence was supplied for a runnable candidate.",
        evidence: [],
        blockers: [],
      });
      continue;
    }
    const rejected = blockers.some((id) => decisions.get(id)?.grade === "rejected");
    decisions.set(candidate.id, {
      id: candidate.id,
      priority: candidate.priority,
      execution: "stopped_prerequisite",
      grade: rejected ? "rejected" : "verification_incomplete",
      prerequisitePassed: false,
      reason: `Stopped because prerequisite evidence did not pass: ${blockers.join(", ")}.`,
      evidence: blockers.flatMap((id) => decisions.get(id)?.evidence ?? []),
      blockers,
    });
  }
  return [...decisions.values()];
}
