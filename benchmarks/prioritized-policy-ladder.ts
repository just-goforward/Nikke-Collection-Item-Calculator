import { stateIdNormalized } from "../src/solver/domain";
import type { SolverInput } from "../src/types";
import { rustCoreExportsFromInstance } from "../src/wasm/rustLoader";
import { createRustMinEfSolver } from "../src/wasm/rustMinEfCore";
import { normalizeRustProductInput } from "../src/wasm/rustProductInput";
import { buildRecommendedRunForKit } from "../src/wasm/rustProductView";
import {
  RUST_STATUS_BUDGET_EXCEEDED,
  RUST_STATUS_MEMO_FULL,
  RustSolveError,
} from "../src/wasm/rustStatus";
import type { RustMinEfPolicyHandle } from "../src/wasm/rustTypes";
import type { ExactPolicySolverResult } from "./evaluator/exact-replan-types";
import {
  prioritizedSparsePiActionAtUses,
  type RustPrioritizedSparsePiOptions,
  type RustPrioritizedSparsePiOutcome,
  type RustPrioritizedSparsePiResult,
  solveRustPrioritizedSparsePi,
} from "./rust-prioritized-sparse-pi";

const SUCCESS_EPSILON = 1e-12;

export const BOUNDED_PRIORITIZED_OPTIONS = {
  horizonFactor: 0.75,
  maxPasses: 4,
  maxStates: 1_200_000,
  maxUpdatesPerPass: 256,
  memoTier: 22,
  normPower: 3,
  priorityMode: "max_path_probability",
  tolerance: 0,
} as const satisfies RustPrioritizedSparsePiOptions;

type MinEfOutcome = "completed" | "memo_full" | "budget_exceeded" | "failure";

export type PrioritizedFallbackSummary = {
  calls: number;
  minEfOutcomes: Record<MinEfOutcome, number>;
  prioritizedOutcomes: Record<RustPrioritizedSparsePiOutcome, number>;
  prioritizedCalls: number;
  maxPrioritizedElapsedMs: number;
  maxProbabilityGap: number;
  maxSuccessInvariantGap: number;
  firstFallbackWitnesses: Array<{
    input: SolverInput;
    result: RustPrioritizedSparsePiResult;
  }>;
};

export function createPrioritizedFallbackLadderSession(
  minEfInstance: WebAssembly.Instance,
  prioritizedInstance: WebAssembly.Instance,
  options: RustPrioritizedSparsePiOptions = BOUNDED_PRIORITIZED_OPTIONS,
) {
  const minEf = createRustMinEfSolver(rustCoreExportsFromInstance(minEfInstance));
  const prioritizedExports = rustCoreExportsFromInstance(prioritizedInstance);
  minEf.configureMemoTier(21);
  const summary = emptySummary();

  function policySolver(input: SolverInput): ExactPolicySolverResult {
    summary.calls += 1;
    const normalized = normalizeRustProductInput(input);
    try {
      const policy = minEf.solveRootWithCandidates(
        normalized.start,
        normalized.stock,
        options.horizonFactor ?? 0.75,
        options.normPower ?? 3,
        options.tolerance ?? 0,
      );
      summary.minEfOutcomes.completed += 1;
      return minEfDecision(input, policy);
    } catch (error) {
      const minEfOutcome = classifyMinEfError(error);
      summary.minEfOutcomes[minEfOutcome] += 1;
      if (minEfOutcome !== "memo_full" && minEfOutcome !== "budget_exceeded") throw error;
    }

    const result = solveRustPrioritizedSparsePi(prioritizedExports, input, options);
    summary.prioritizedCalls += 1;
    summary.prioritizedOutcomes[result.outcome] += 1;
    summary.maxPrioritizedElapsedMs = Math.max(summary.maxPrioritizedElapsedMs, result.elapsedMs);
    summary.maxProbabilityGap = Math.max(summary.maxProbabilityGap, result.probabilityGap);
    summary.maxSuccessInvariantGap = Math.max(
      summary.maxSuccessInvariantGap,
      result.successInvariantMaxGap,
    );
    if (summary.firstFallbackWitnesses.length < 8) {
      summary.firstFallbackWitnesses.push({ input: structuredClone(input), result });
    }

    if (result.outcome !== "completed" && result.outcome !== "iteration_budget_exceeded") {
      throw new Error(
        `Bounded prioritized policy did not produce a usable policy: ${result.outcome}.`,
      );
    }
    if (
      result.probabilityGap > SUCCESS_EPSILON ||
      result.successInvariantChecks <= 0 ||
      result.successInvariantMaxGap > SUCCESS_EPSILON
    ) {
      throw new Error(
        `Bounded prioritized policy failed the tau=0 success invariant: ` +
          `gap=${result.probabilityGap}, invariant=${result.successInvariantMaxGap}.`,
      );
    }
    if (!result.finalAction) return { possible: false, best: null };

    const run = buildRecommendedRunForKit(
      normalized,
      (state, stockUses) =>
        prioritizedSparsePiActionAtUses(prioritizedExports, stateIdNormalized(state), stockUses),
      result.finalAction,
    );
    if (!run) return { possible: false, best: null };
    return {
      possible: true,
      best: {
        firstAction: result.finalAction,
        probabilityGap: result.probabilityGap,
        run: { count: run.count },
      },
    };
  }

  return {
    policySolver,
    release() {
      minEf.releaseMemo();
      prioritizedExports.releasePhase2Memo?.();
    },
    summary: () => structuredClone(summary),
  };
}

function minEfDecision(input: SolverInput, policy: RustMinEfPolicyHandle): ExactPolicySolverResult {
  const root = policy.root;
  if (!root.firstAction) return { possible: false, best: null };
  const normalized = normalizeRustProductInput(input);
  const run = buildRecommendedRunForKit(
    normalized,
    (state, stockUses) => policy.actionAt(state, stockUses),
    root.firstAction,
  );
  if (!run) return { possible: false, best: null };
  return {
    possible: true,
    best: {
      firstAction: root.firstAction,
      probabilityGap: Math.max(0, root.maxSuccessProbability - root.successProbability),
      run: { count: run.count },
    },
  };
}

function classifyMinEfError(error: unknown): MinEfOutcome {
  if (error instanceof RustSolveError) {
    if (error.status === RUST_STATUS_MEMO_FULL) return "memo_full";
    if (error.status === RUST_STATUS_BUDGET_EXCEEDED) return "budget_exceeded";
  }
  return "failure";
}

function emptySummary(): PrioritizedFallbackSummary {
  return {
    calls: 0,
    minEfOutcomes: { completed: 0, memo_full: 0, budget_exceeded: 0, failure: 0 },
    prioritizedOutcomes: Object.fromEntries(
      [
        "completed",
        "phase2_failure",
        "iteration_budget_exceeded",
        "state_budget_exceeded",
        "invalid_input",
        "probability_invariant_violation",
        "closure_incomplete",
      ].map((outcome) => [outcome, 0]),
    ) as Record<RustPrioritizedSparsePiOutcome, number>,
    prioritizedCalls: 0,
    maxPrioritizedElapsedMs: 0,
    maxProbabilityGap: 0,
    maxSuccessInvariantGap: 0,
    firstFallbackWitnesses: [],
  };
}
