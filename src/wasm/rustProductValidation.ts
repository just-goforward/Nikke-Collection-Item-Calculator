import type { SolverInput } from "../types";
import { isMemoFull } from "./rustCore";
import {
  RUST_PRODUCT_HORIZON_FACTOR,
  RUST_PRODUCT_NORM_POWER,
  RUST_PRODUCT_TOLERANCE,
} from "./rustProductConfig";
import { normalizeRustProductInput } from "./rustProductInput";
import {
  getRustMinEfSolver,
  getRustPhase2Solver,
  minEfActionFactory,
} from "./rustProductSolverCache";
import { simulate } from "./rustProductView";
import { selectAdaptiveRerankDecision } from "./rustRerankDecision";

export async function validateRustMinEf(
  input: SolverInput,
  wasmUrl: string,
  runs: number,
  seed = 20260505,
) {
  const normalizedInput = normalizeRustProductInput(input);
  try {
    const solver = await getRustMinEfSolver(wasmUrl);
    solver.solveRoot(
      normalizedInput.start,
      normalizedInput.stock,
      RUST_PRODUCT_HORIZON_FACTOR,
      RUST_PRODUCT_NORM_POWER,
      RUST_PRODUCT_TOLERANCE,
    );
    return simulate(normalizedInput, minEfActionFactory(solver), runs, seed);
  } catch (error) {
    if (!isMemoFull(error)) throw error;
    return validateRustPhase2(input, wasmUrl, runs, seed);
  }
}

export async function validateRustPhase2(
  input: SolverInput,
  wasmUrl: string,
  runs: number,
  seed = 20260505,
) {
  const normalizedInput = normalizeRustProductInput(input);
  const solver = await getRustPhase2Solver(wasmUrl);
  solver.solveRoot(
    normalizedInput.start,
    normalizedInput.stock,
    RUST_PRODUCT_HORIZON_FACTOR,
    RUST_PRODUCT_NORM_POWER,
    RUST_PRODUCT_TOLERANCE,
  );
  return solver.simulatePolicy(
    normalizedInput.start,
    normalizedInput.stock,
    runs,
    seed,
    RUST_PRODUCT_HORIZON_FACTOR,
    RUST_PRODUCT_NORM_POWER,
    RUST_PRODUCT_TOLERANCE,
  );
}

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
