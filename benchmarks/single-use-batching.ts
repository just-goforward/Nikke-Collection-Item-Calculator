import type { SolverInput } from "../src/types";
import type { ExactPolicySolverResult } from "./evaluator/exact-replan-types";

export function forceSingleUseBatching(
  policySolver: (input: SolverInput) => ExactPolicySolverResult,
) {
  return (input: SolverInput): ExactPolicySolverResult => {
    const result = policySolver(input);
    if (!result.possible || !result.best?.run) return result;
    return {
      ...result,
      best: {
        ...result.best,
        run: { count: 1 },
      },
    };
  };
}
