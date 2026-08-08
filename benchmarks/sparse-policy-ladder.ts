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
  createSparsePolicyIterationSolver,
  type SparsePolicyIterationDecision,
  type SparsePolicyIterationOptions,
} from "./sparse-policy-iteration";

export type SparseFallbackTrace = {
  minEfOutcome: "completed" | "memo_full" | "budget_exceeded" | "failure";
  sparseOutcome: SparsePolicyIterationDecision["result"]["outcome"] | "not_run";
  selectedBackend: "rust-min-ef" | "sparse-policy-iteration" | null;
};

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

function classifyMinEfError(error: unknown): SparseFallbackTrace["minEfOutcome"] {
  if (error instanceof RustSolveError) {
    if (error.status === RUST_STATUS_MEMO_FULL) return "memo_full";
    if (error.status === RUST_STATUS_BUDGET_EXCEEDED) return "budget_exceeded";
  }
  return "failure";
}

export function createSparseFallbackLadderSession(
  minEfInstance: WebAssembly.Instance,
  sparseInstance: WebAssembly.Instance,
  options: SparsePolicyIterationOptions = {},
) {
  const minEf = createRustMinEfSolver(rustCoreExportsFromInstance(minEfInstance));
  minEf.configureMemoTier(21);
  const sparse = createSparsePolicyIterationSolver(
    rustCoreExportsFromInstance(sparseInstance),
    options,
  );
  const traces: SparseFallbackTrace[] = [];

  function policySolver(input: SolverInput): ExactPolicySolverResult {
    const normalized = normalizeRustProductInput(input);
    try {
      const policy = minEf.solveRootWithCandidates(
        normalized.start,
        normalized.stock,
        options.horizonFactor ?? 0.75,
        options.normPower ?? 3,
        options.tolerance ?? 0,
      );
      traces.push({
        minEfOutcome: "completed",
        sparseOutcome: "not_run",
        selectedBackend: "rust-min-ef",
      });
      return minEfDecision(input, policy);
    } catch (error) {
      const minEfOutcome = classifyMinEfError(error);
      if (minEfOutcome !== "memo_full" && minEfOutcome !== "budget_exceeded") {
        traces.push({ minEfOutcome, sparseOutcome: "not_run", selectedBackend: null });
        throw error;
      }
      const decision = sparse.solve(input);
      const sparseOutcome = sparse.decisions.at(-1)?.result.outcome ?? "phase2_failure";
      traces.push({
        minEfOutcome,
        sparseOutcome,
        selectedBackend: "sparse-policy-iteration",
      });
      return decision;
    }
  }

  return {
    policySolver,
    sparseDecisions: () => sparse.decisions,
    traces: () => traces,
  };
}
