import type { SolverInput } from "../types";
import { isMemoFull } from "./rustCore";
import { solveRustPhase2 } from "./rustPhase2ProductSolver";
import {
  RUST_MIN_EF_SOLVER_VERSION,
  RUST_PRODUCT_HORIZON_FACTOR,
  RUST_PRODUCT_NORM_POWER,
  RUST_PRODUCT_TOLERANCE,
} from "./rustProductConfig";
import {
  normalizeRustProductInput,
  readRustMonteCarloRuns,
  readRustMonteCarloSeed,
} from "./rustProductInput";
import {
  buildRustEarlyResult,
  buildRustNoActionResult,
  buildRustRootResult,
} from "./rustProductResults";
import { getRustMinEfSolver, minEfActionFactory } from "./rustProductSolverCache";
import {
  buildFailureRoute,
  buildPhase2TopCandidates,
  buildRecommendedRun,
  simulate,
} from "./rustProductView";

export async function solveRustMinEfProduct(
  input: SolverInput,
  wasmUrl: string,
  progress?: (progress: { phase: string; scanned?: number; total?: number | null }) => void,
) {
  const normalizedInput = normalizeRustProductInput(input);
  if (progress) progress({ phase: "build", scanned: 0, total: 1 });

  const earlyResult = buildRustEarlyResult(normalizedInput, RUST_MIN_EF_SOLVER_VERSION);
  if (earlyResult) return earlyResult;
  try {
    const solver = await getRustMinEfSolver(wasmUrl);
    const { root, candidates } = solver.solveRootWithCandidates(
      normalizedInput.start,
      normalizedInput.stock,
      RUST_PRODUCT_HORIZON_FACTOR,
      RUST_PRODUCT_NORM_POWER,
      RUST_PRODUCT_TOLERANCE,
    );
    if (!root.firstAction) {
      return buildRustNoActionResult(normalizedInput, "현재 보유 키트로 가능한 행동이 없습니다.");
    }

    const actionFor = minEfActionFactory(solver);
    const topCandidates = buildPhase2TopCandidates(
      normalizedInput,
      candidates,
      actionFor,
      "Rust min E[f]",
    );
    const run = buildRecommendedRun(normalizedInput, actionFor);
    const route = buildFailureRoute(normalizedInput, actionFor);
    const monteCarloRuns = readRustMonteCarloRuns(input);
    const monteCarloSeed = readRustMonteCarloSeed(input);
    const monteCarlo =
      monteCarloRuns > 0
        ? simulate(normalizedInput, actionFor, monteCarloRuns, monteCarloSeed)
        : {
            runs: 0,
            completed: 0,
            successProbability: root.successProbability,
            vector: { blue: 0, purple: 0, yellow: 0 },
          };

    if (progress) progress({ phase: "done", scanned: 1, total: 1 });

    return buildRustRootResult({
      input: normalizedInput,
      root: { ...root, firstAction: root.firstAction },
      name: "Rust min E[f]",
      solverBackend: "rust-min-ef",
      solverVersion: RUST_MIN_EF_SOLVER_VERSION,
      solverPhase: "phase3",
      resourceCost: root.expectedCost,
      states: root.states,
      candidateCount: topCandidates.length,
      run,
      route,
      monteCarlo,
      topCandidates,
      statsExtras: {
        rustMinEf: {
          horizonFactor: RUST_PRODUCT_HORIZON_FACTOR,
          normPower: RUST_PRODUCT_NORM_POWER,
          expectedCost: root.expectedCost,
          nodeCount: root.states,
        },
      },
    });
  } catch (error) {
    if (!isMemoFull(error)) throw error;
    if (progress) progress({ phase: "fallback-phase2", scanned: 0, total: 1 });
    return solveRustPhase2(input, wasmUrl, progress);
  }
}

export async function solveRustMinEf(
  input: SolverInput,
  wasmUrl: string,
  progress?: (progress: { phase: string; scanned?: number; total?: number | null }) => void,
) {
  return solveRustMinEfProduct(input, wasmUrl, progress);
}
