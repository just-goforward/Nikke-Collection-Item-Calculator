export const MIN_EF_GROW_RESUME_CONTRACT = {
  studyId: "min-ef-grow-resume",
  protocolVersion: 1,
  sourceTier: 21,
  targetTier: 22,
  horizonFactor: 0.75,
  normPower: 3,
  tolerance: 0,
  minEfNodeBudget: 4_000_000,
  phase2Tier: 22,
  memoryAllowanceBytes: 16 * 1024 * 1024,
  restartMedianImprovement: 0.2,
  freshResumeP95Limit: { relativeFactor: 1.05, absoluteMarginMs: 2 },
  currentLadderP95Limit: { relativeFactor: 1.15, absoluteMarginMs: 50 },
  wasmBudgetBytes: 115_000,
  screening: "single fresh process per arm and scenario",
  percentileEstimator: "nearest_rank_ceil",
} as const;

export type GrowResumeOutcome = "budget_exceeded" | "completed" | "failure" | "memo_full";

export function classifySolveStatus(status: number): GrowResumeOutcome {
  if (status === 0) return "completed";
  if (status === 1) return "budget_exceeded";
  if (status === 2) return "memo_full";
  return "failure";
}

export function latencyLimit(
  baselineMs: number,
  policy: { absoluteMarginMs: number; relativeFactor: number },
): number {
  return Math.max(baselineMs * policy.relativeFactor, baselineMs + policy.absoluteMarginMs);
}

export function memoryGatePassed(candidateGrowthBytes: number, freshGrowthBytes: number): boolean {
  return (
    candidateGrowthBytes <= freshGrowthBytes + MIN_EF_GROW_RESUME_CONTRACT.memoryAllowanceBytes
  );
}

export function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new Error("Cannot summarize an empty sample set.");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  const value = sorted[index];
  if (value === undefined) throw new Error("Percentile index was outside the sample set.");
  return value;
}
