import type { CollectionState, Grade } from "./domain";

export type StageReachPoint = {
  grade: Grade;
  level: number;
  reached: number;
  probability: number;
};

const MAX_STAGE_RANK = 30;

export function stageRank(state: CollectionState) {
  if (state.grade === "SR") return Math.min(MAX_STAGE_RANK, 15 + Math.max(0, state.level));
  return Math.min(14, Math.max(0, state.level));
}

function stageFromRank(rank: number): { grade: Grade; level: number } {
  const normalized = Math.max(0, Math.min(MAX_STAGE_RANK, Math.floor(rank)));
  if (normalized <= 14) return { grade: "R", level: normalized };
  return { grade: "SR", level: normalized - 15 };
}

export function makeStageReachDistribution(finalRanks: number[], runs: number) {
  const denominator = Math.max(1, runs);
  const counts = new Array<number>(MAX_STAGE_RANK + 1).fill(0);

  for (const rank of finalRanks) {
    const finalRank = Math.max(0, Math.min(MAX_STAGE_RANK, Math.floor(rank)));
    for (let threshold = 0; threshold <= finalRank; threshold += 1) {
      counts[threshold] = (counts[threshold] ?? 0) + 1;
    }
  }

  return counts.map((reached, rank): StageReachPoint => {
    const stage = stageFromRank(rank);
    return {
      ...stage,
      reached,
      probability: reached / denominator,
    };
  });
}
