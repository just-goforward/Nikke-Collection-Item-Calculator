import type { SolverInput } from "../src/types";
import {
  RUST_PRODUCT_HORIZON_FACTOR,
  RUST_PRODUCT_NORM_POWER,
  RUST_PRODUCT_TOLERANCE,
} from "../src/wasm/rustProductConfig";
import { normalizeRustProductInput } from "../src/wasm/rustProductInput";
import { buildRecommendedRunForKit } from "../src/wasm/rustProductView";
import { selectAdaptiveRerankDecision } from "../src/wasm/rustRerankDecision";
import type {
  RustExactRerankResult,
  RustPhase2Policy,
  RustPhase2ResearchSolver,
} from "../src/wasm/rustTypes";
import type { ExactPolicySolverResult } from "./evaluator/exact-replan-types";

export type RustPolicyId = "phase2_baseline" | "phase2_mc_rerank" | "phase2_exact_rerank";

function decisionFromPolicy(
  input: SolverInput,
  policy: RustPhase2Policy,
  firstAction: RustPhase2Policy["root"]["firstAction"],
  probabilityGap: number,
): ExactPolicySolverResult {
  if (!firstAction) return { possible: false, best: null };
  const normalized = normalizeRustProductInput(input);
  const run = buildRecommendedRunForKit(
    normalized,
    (state, stockUses) => policy.actionAt(state, stockUses),
    firstAction,
  );
  if (!run) return { possible: false, best: null };
  return {
    possible: true,
    best: {
      firstAction,
      run: { count: run.count },
      probabilityGap,
    },
  };
}

function exactDecision(
  input: SolverInput,
  selection: RustExactRerankResult | null,
): ExactPolicySolverResult {
  if (!selection) return { possible: false, best: null };
  return decisionFromPolicy(
    input,
    selection.policy,
    selection.selected.firstAction,
    selection.selected.probabilityGap,
  );
}

export function createRustPolicySolvers(
  solver: RustPhase2ResearchSolver,
): Record<RustPolicyId, (input: SolverInput) => ExactPolicySolverResult> {
  return {
    phase2_baseline(input) {
      const normalized = normalizeRustProductInput(input);
      const policy = solver.buildPolicy(
        normalized.start,
        normalized.stock,
        RUST_PRODUCT_HORIZON_FACTOR,
        RUST_PRODUCT_NORM_POWER,
        RUST_PRODUCT_TOLERANCE,
      );
      const probabilityGap = Math.max(
        0,
        policy.root.maxSuccessProbability - policy.root.successProbability,
      );
      return decisionFromPolicy(input, policy, policy.root.firstAction, probabilityGap);
    },
    phase2_mc_rerank(input) {
      const normalized = normalizeRustProductInput(input);
      const decision = selectAdaptiveRerankDecision(solver, normalized);
      if (!decision) return { possible: false, best: null };
      return decisionFromPolicy(
        input,
        decision.rerank.policy,
        decision.selected.firstAction,
        decision.selected.probabilityGap,
      );
    },
    phase2_exact_rerank(input) {
      const normalized = normalizeRustProductInput(input);
      return exactDecision(
        input,
        solver.selectFirstActionByExactExpectedCost(
          normalized.start,
          normalized.stock,
          RUST_PRODUCT_HORIZON_FACTOR,
          RUST_PRODUCT_NORM_POWER,
          RUST_PRODUCT_TOLERANCE,
        ),
      );
    },
  };
}
