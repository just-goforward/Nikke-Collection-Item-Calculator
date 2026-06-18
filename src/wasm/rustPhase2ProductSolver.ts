import { availabilityCostScore } from "../solver/cost";
import {
  isConvertStateNormalized as isConvertState,
  isTerminalNormalized as isTerminal,
} from "../solver/domain";
import type { CollectionState, SolverInput, Stock } from "../types";
import {
  RUST_PHASE2_SOLVER_VERSION,
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
import { getRustPhase2Solver } from "./rustProductSolverCache";
import {
  buildFailureRoute,
  buildPhase2TopCandidates,
  buildRecommendedRun,
} from "./rustProductView";

export async function solveRustPhase2(
  input: SolverInput,
  wasmUrl: string,
  progress?: (progress: { phase: string; scanned?: number; total?: number | null }) => void,
) {
  const startedAt = nowMs();
  const normalizedInput = normalizeRustProductInput(input);
  if (progress) progress({ phase: "build", scanned: 0, total: 1 });

  const earlyResult = buildRustEarlyResult(normalizedInput, RUST_PHASE2_SOLVER_VERSION);
  if (earlyResult) return earlyResult;

  const solver = await getRustPhase2Solver(wasmUrl);
  const policy = solver.buildPolicy(
    normalizedInput.start,
    normalizedInput.stock,
    RUST_PRODUCT_HORIZON_FACTOR,
    RUST_PRODUCT_NORM_POWER,
    RUST_PRODUCT_TOLERANCE,
  );
  const root = policy.root;
  if (!root.firstAction) {
    return buildRustNoActionResult(normalizedInput, "현재 보유 키트로 가능한 행동이 없습니다.");
  }

  const actionFor = (state: CollectionState, stockUses: Stock) => {
    if (isTerminal(state) || isConvertState(state)) return null;
    return policy.actionAt(state, stockUses);
  };
  const topCandidates = buildPhase2TopCandidates(normalizedInput, policy.candidates, actionFor);
  const run = buildRecommendedRun(normalizedInput, actionFor);
  const route = buildFailureRoute(normalizedInput, actionFor);
  const availabilityCost = availabilityCostScore(root.vector, normalizedInput.stock);
  const monteCarloRuns = readRustMonteCarloRuns(input);
  const monteCarloSeed = readRustMonteCarloSeed(input);
  const monteCarlo =
    monteCarloRuns > 0
      ? solver.simulatePolicy(
          normalizedInput.start,
          normalizedInput.stock,
          monteCarloRuns,
          monteCarloSeed,
          RUST_PRODUCT_HORIZON_FACTOR,
          RUST_PRODUCT_NORM_POWER,
          RUST_PRODUCT_TOLERANCE,
        )
      : {
          runs: 0,
          completed: 0,
          successProbability: root.successProbability,
          vector: { blue: 0, purple: 0, yellow: 0 },
        };

  if (progress) progress({ phase: "done", scanned: root.states, total: root.states });

  return buildRustRootResult({
    input: normalizedInput,
    root: { ...root, firstAction: root.firstAction },
    name: "Rust phase2",
    solverBackend: "rust-phase2",
    solverVersion: RUST_PHASE2_SOLVER_VERSION,
    solverPhase: "phase2",
    resourceCost: availabilityCost,
    states: root.states,
    candidateCount: topCandidates.length,
    run,
    route,
    monteCarlo,
    topCandidates,
    statsExtras: {
      solveMs: elapsedMs(startedAt),
    },
  });
}

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function elapsedMs(startedAt: number) {
  return Math.max(0, Math.round((nowMs() - startedAt) * 100) / 100);
}
