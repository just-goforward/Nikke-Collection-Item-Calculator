import type { HpExactGateResult } from "./min-ef-hp-quality";

export type ResearchCandidateClass =
  | "exact_product"
  | "approximate_product"
  | "objective_variant"
  | "offline_oracle";

export type ResearchOutcome =
  | "completed"
  | "memo_full"
  | "budget_exceeded"
  | "device_unavailable"
  | "device_lost"
  | "numeric_ambiguous"
  | "failure";

export type ResearchGrade =
  | "product_candidate"
  | "research_tradeoff"
  | "rejected"
  | "verification_incomplete";

export type ResearchCandidateId =
  | "certified_limited_depth"
  | "admissible_ao_star_brtdp"
  | "lp_column_generation_oracle"
  | "pareto_frontier_dp"
  | "monotonicity_threshold_proof"
  | "symbolic_decision_diagram"
  | "gpu_rollout_mcts"
  | "distributional_chance_constraint"
  | "adaptive_hp_robust_risk"
  | "complete_policy_enumeration"
  | "webgpu_compact_exact_hybrid";

export type ResearchCandidateContract = {
  id: ResearchCandidateId;
  class: ResearchCandidateClass;
  priority: number;
  hypothesis: string;
  prerequisites: ResearchCandidateId[];
  stop: {
    maxStates?: number;
    maxVectors?: number;
    maxWarmLatencyRatio?: number;
    minimumGpuThroughputRatio?: number;
  };
};

export const NEXT_SOLVER_RESEARCH_POLICY = {
  id: "exact_range_first_cpu_f64_authority_v1",
  baseline: { horizonFactor: 0.75, normPower: 3, tolerance: 0 },
  primaryFixture: "R10-balanced300",
  rawWasmBudgetBytes: 115_000,
  lazyWebGpuGzipBudgetBytes: 25_000,
  exactStateBudget: 1_200_000,
  paretoVectorBudget: 2_000_000,
  paretoP95WidthLimit: 32,
  symbolicMinimumReduction: 0.3,
  symbolicMaximumLookupOverhead: 0.15,
  gpuMinimumRolloutThroughputRatio: 10,
  gpuExactConfirmationRate: 0.1,
} as const;

export const RESEARCH_CANDIDATES: readonly ResearchCandidateContract[] = [
  {
    id: "complete_policy_enumeration",
    class: "offline_oracle",
    priority: 0,
    hypothesis:
      "Tiny acyclic fixtures can enumerate every deterministic policy and expose an independent exact root optimum.",
    prerequisites: [],
    stop: { maxStates: 12 },
  },
  {
    id: "lp_column_generation_oracle",
    class: "offline_oracle",
    priority: 1,
    hypothesis:
      "A compact occupancy-measure model can independently verify maximum reachability before cost optimization.",
    prerequisites: ["complete_policy_enumeration"],
    stop: { maxStates: 100_000 },
  },
  {
    id: "webgpu_compact_exact_hybrid",
    class: "exact_product",
    priority: 2,
    hypothesis:
      "GPU integer frontier construction plus CPU f64 Bellman evaluation can complete an existing min-E[f] failure without changing semantics.",
    prerequisites: ["complete_policy_enumeration"],
    stop: { maxWarmLatencyRatio: 1.15 },
  },
  {
    id: "certified_limited_depth",
    class: "exact_product",
    priority: 3,
    hypothesis:
      "Admissible value intervals can certify the root action before expanding the complete min-E[f] graph.",
    prerequisites: ["complete_policy_enumeration"],
    stop: { maxStates: 1_200_000, maxWarmLatencyRatio: 1.15 },
  },
  {
    id: "admissible_ao_star_brtdp",
    class: "exact_product",
    priority: 4,
    hypothesis:
      "Root-uncertainty-directed expansion can use a certified interval more efficiently than the rejected exhaustive branch-and-bound prepass.",
    prerequisites: ["certified_limited_depth"],
    stop: { maxStates: 1_200_000, maxWarmLatencyRatio: 1.15 },
  },
  {
    id: "pareto_frontier_dp",
    class: "objective_variant",
    priority: 5,
    hypothesis:
      "Reachable per-state risk-return frontiers remain narrow enough to preserve alternatives without scalarizing user preferences.",
    prerequisites: ["complete_policy_enumeration"],
    stop: { maxVectors: 2_000_000 },
  },
  {
    id: "monotonicity_threshold_proof",
    class: "offline_oracle",
    priority: 6,
    hypothesis:
      "Restricted inventory and progress regions contain provable monotone action structure usable for exact pruning.",
    prerequisites: ["complete_policy_enumeration"],
    stop: {},
  },
  {
    id: "symbolic_decision_diagram",
    class: "exact_product",
    priority: 7,
    hypothesis:
      "Repeated transition and value partitions reduce the exact graph by at least thirty percent without approximate state merging.",
    prerequisites: ["monotonicity_threshold_proof"],
    stop: { maxWarmLatencyRatio: 1.15 },
  },
  {
    id: "gpu_rollout_mcts",
    class: "approximate_product",
    priority: 8,
    hypothesis:
      "GPU common-random-number rollouts screen useful root changes cheaply enough that CPU exact confirmation accepts at least ten percent.",
    prerequisites: ["webgpu_compact_exact_hybrid"],
    stop: { minimumGpuThroughputRatio: 10 },
  },
  {
    id: "distributional_chance_constraint",
    class: "objective_variant",
    priority: 9,
    hypothesis:
      "A bounded distribution representation lowers supply-debt tail risk while satisfying the shared product guardrails.",
    prerequisites: ["pareto_frontier_dp"],
    stop: { maxVectors: 2_000_000, maxWarmLatencyRatio: 1.15 },
  },
  {
    id: "adaptive_hp_robust_risk",
    class: "objective_variant",
    priority: 10,
    hypothesis:
      "At most four pre-registered H/p regions improve tail risk under gain uncertainty without worsening shared product axes.",
    prerequisites: ["distributional_chance_constraint"],
    stop: { maxWarmLatencyRatio: 1.15 },
  },
] as const;

export function candidateContract(id: ResearchCandidateId): ResearchCandidateContract {
  const candidate = RESEARCH_CANDIDATES.find((item) => item.id === id);
  if (!candidate) throw new Error(`Unknown research candidate: ${id}`);
  return candidate;
}

export function runnableCandidates(
  completed: ReadonlySet<ResearchCandidateId>,
  rejected: ReadonlySet<ResearchCandidateId> = new Set(),
): ResearchCandidateContract[] {
  return RESEARCH_CANDIDATES.filter(
    (candidate) =>
      !completed.has(candidate.id) &&
      !rejected.has(candidate.id) &&
      candidate.prerequisites.every((dependency) => completed.has(dependency)),
  ).sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

export function classifySharedProductGate(input: {
  exactGates: readonly HpExactGateResult[];
  tailRiskPassed: boolean | null;
  hasStrictTailImprovement: boolean;
  performancePassed: boolean | null;
  hasNewFailure: boolean;
}): ResearchGrade {
  if (
    input.exactGates.length === 0 ||
    input.exactGates.some((gate) => gate.status === "verification_incomplete") ||
    input.tailRiskPassed === null ||
    input.performancePassed === null
  ) {
    return "verification_incomplete";
  }
  const failed = input.exactGates.filter((gate) => gate.status === "failed");
  const totalOnlyTradeoff =
    failed.length > 0 &&
    failed.every((gate) => gate.violations.every((violation) => violation === "total_uses"));
  if (
    input.hasNewFailure ||
    failed.length > 0 ||
    !input.tailRiskPassed ||
    !input.performancePassed
  ) {
    return totalOnlyTradeoff ? "research_tradeoff" : "rejected";
  }
  const strictExact = input.exactGates.some((gate) => gate.strictImprovement);
  return strictExact || input.hasStrictTailImprovement ? "product_candidate" : "rejected";
}
