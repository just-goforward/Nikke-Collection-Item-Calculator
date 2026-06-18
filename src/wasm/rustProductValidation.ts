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

export async function validateRustMinEf(
  input: SolverInput,
  wasmUrl: string,
  runs: number,
  seed = 20260505,
) {
  const normalizedInput = normalizeRustProductInput(input);
  try {
    const solver = await getRustMinEfSolver(wasmUrl);
    const policy = solver.solveRootWithCandidates(
      normalizedInput.start,
      normalizedInput.stock,
      RUST_PRODUCT_HORIZON_FACTOR,
      RUST_PRODUCT_NORM_POWER,
      RUST_PRODUCT_TOLERANCE,
    );
    return simulate(normalizedInput, minEfActionFactory(policy), runs, seed);
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
