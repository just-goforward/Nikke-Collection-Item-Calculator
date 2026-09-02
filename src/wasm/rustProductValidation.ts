import type { SolverInput } from "../types";
import { activeSupplyForecastContext } from "./rustCoreShared";
import {
  RUST_MIN_EF_MEMO_TIER,
  RUST_PHASE2_DEFAULT_MEMO_TIER,
  RUST_PHASE2_FALLBACK_MEMO_TIER,
  RUST_PRODUCT_HORIZON_FACTOR,
  RUST_PRODUCT_NORM_POWER,
  RUST_PRODUCT_TOLERANCE,
} from "./rustProductConfig";
import { normalizeRustProductInput } from "./rustProductInput";
import {
  getRustMinEfSolver,
  getRustPhase2Solver,
  minEfActionFactory,
  minEfPolicyCacheKey,
  readLastMinEfPolicy,
  releaseRustMinEfSolverCache,
  rememberLastMinEfPolicy,
} from "./rustProductSolverCache";
import { simulate } from "./rustProductView";
import { isMemoFull, RustSolveError } from "./rustStatus";
import type { RustPhase2Policy } from "./rustTypes";

export async function validateRustMinEf(
  input: SolverInput,
  wasmUrl: string,
  runs: number,
  seed = 20260505,
) {
  const normalizedInput = normalizeRustProductInput(input);
  const supplyForecast = activeSupplyForecastContext();
  const cacheKey = minEfPolicyCacheKey({
    horizonFactor: RUST_PRODUCT_HORIZON_FACTOR,
    input: normalizedInput,
    memoTier: RUST_MIN_EF_MEMO_TIER,
    normPower: RUST_PRODUCT_NORM_POWER,
    supplyForecast,
    tolerance: RUST_PRODUCT_TOLERANCE,
  });
  const cachedPolicy = readLastMinEfPolicy(cacheKey);
  if (cachedPolicy) {
    try {
      return {
        ...simulate(normalizedInput, minEfActionFactory(cachedPolicy), runs, seed),
        validationPolicyCache: "hit" as const,
      };
    } catch (error) {
      if (!(error instanceof RustSolveError) || error.reason !== "stale_handle") throw error;
    }
  }

  try {
    const solver = await getRustMinEfSolver(wasmUrl);
    solver.setSupplyForecast(supplyForecast);
    const policy = solver.solveRootWithCandidates(
      normalizedInput.start,
      normalizedInput.stock,
      RUST_PRODUCT_HORIZON_FACTOR,
      RUST_PRODUCT_NORM_POWER,
      RUST_PRODUCT_TOLERANCE,
    );
    rememberLastMinEfPolicy(cacheKey, policy);
    return {
      ...simulate(normalizedInput, minEfActionFactory(policy), runs, seed),
      validationPolicyCache: "miss" as const,
    };
  } catch (error) {
    if (!isMemoFull(error)) throw error;
    await releaseRustMinEfSolverCache();
    return {
      ...(await validateRustPhase2(input, wasmUrl, runs, seed)),
      validationPolicyCache: "miss" as const,
    };
  }
}

export async function validateRustPhase2(
  input: SolverInput,
  wasmUrl: string,
  runs: number,
  seed = 20260505,
) {
  const normalizedInput = normalizeRustProductInput(input);
  const supplyForecast = activeSupplyForecastContext();
  const solver = await getRustPhase2Solver(wasmUrl);
  solver.setSupplyForecast(supplyForecast);
  solver.configureMemoTier(RUST_PHASE2_DEFAULT_MEMO_TIER);
  solver.configureSegmentedOverflow(false);
  let policy: RustPhase2Policy;
  try {
    policy = solver.buildPolicy(
      normalizedInput.start,
      normalizedInput.stock,
      RUST_PRODUCT_HORIZON_FACTOR,
      RUST_PRODUCT_NORM_POWER,
      RUST_PRODUCT_TOLERANCE,
    );
  } catch (error) {
    if (!isMemoFull(error)) throw error;
    solver.releaseMemo();
    solver.configureMemoTier(RUST_PHASE2_FALLBACK_MEMO_TIER);
    solver.configureSegmentedOverflow(true);
    policy = solver.buildPolicy(
      normalizedInput.start,
      normalizedInput.stock,
      RUST_PRODUCT_HORIZON_FACTOR,
      RUST_PRODUCT_NORM_POWER,
      RUST_PRODUCT_TOLERANCE,
    );
  }
  return policy.simulate(runs, seed);
}
