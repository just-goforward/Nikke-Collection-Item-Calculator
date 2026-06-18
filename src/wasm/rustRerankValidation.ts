import type { SolverInput } from "../types";
import {
  RUST_PRODUCT_HORIZON_FACTOR,
  RUST_PRODUCT_NORM_POWER,
  RUST_PRODUCT_TOLERANCE,
} from "./rustProductConfig";
import { normalizeRustProductInput } from "./rustProductInput";
import { getRustPhase2Solver } from "./rustProductSolverCache";
import { selectAdaptiveRerankDecision } from "./rustRerankDecision";

export async function validateRustPhase2Rerank(
  input: SolverInput,
  wasmUrl: string,
  runs: number,
  seed = 20260505,
) {
  const normalizedInput = normalizeRustProductInput(input);
  const solver = await getRustPhase2Solver(wasmUrl);
  const decision = selectAdaptiveRerankDecision(solver, normalizedInput);
  const firstKit = decision?.selected.firstAction;
  if (!firstKit) {
    return {
      runs,
      completed: 0,
      successProbability: 0,
      vector: { blue: 0, purple: 0, yellow: 0 },
    };
  }
  return solver.simulatePolicyAfterFirstAction(
    normalizedInput.start,
    normalizedInput.stock,
    firstKit,
    runs,
    seed,
    RUST_PRODUCT_HORIZON_FACTOR,
    RUST_PRODUCT_NORM_POWER,
    RUST_PRODUCT_TOLERANCE,
  );
}
