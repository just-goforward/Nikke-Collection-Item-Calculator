import type { SolverInput } from "../src/types";
import { normalizeRustProductInput } from "../src/wasm/rustProductInput";
import { buildRecommendedRunForKit } from "../src/wasm/rustProductView";
import type { RustMinEfPolicyHandle, RustPhase2Policy } from "../src/wasm/rustTypes";
import type { ExactPolicySolverResult } from "./evaluator/exact-replan-types";

export function decisionFromRootPolicy(
  input: SolverInput,
  policy: RustMinEfPolicyHandle | RustPhase2Policy,
): ExactPolicySolverResult {
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
