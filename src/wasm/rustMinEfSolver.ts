import type { SolverInput } from "../types";
import { activeSupplyForecastContext } from "./rustCoreShared";
import { solveRustPhase2 } from "./rustPhase2ProductSolver";
import {
  RUST_MEMORY_STRATEGY,
  RUST_MIN_EF_MEMO_TIER,
  RUST_MIN_EF_SOLVER_VERSION,
  RUST_PHASE2_FALLBACK_MEMO_TIER,
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
import {
  getRustMinEfSolver,
  minEfActionFactory,
  minEfPolicyCacheKey,
  releaseRustMinEfSolverCache,
  rememberLastMinEfPolicy,
} from "./rustProductSolverCache";
import {
  buildFailureRoute,
  buildPhase2TopCandidates,
  buildRecommendedRun,
  simulate,
} from "./rustProductView";
import { isMemoFull } from "./rustStatus";

export async function solveRustMinEfProduct(
  input: SolverInput,
  wasmUrl: string,
  progress?: (progress: { phase: string; scanned?: number; total?: number | null }) => void,
  options: { fallbackToPhase2?: boolean } = {},
) {
  const startedAt = nowMs();
  const normalizedInput = normalizeRustProductInput(input);
  if (progress) progress({ phase: "build", scanned: 0, total: 1 });

  const earlyResult = buildRustEarlyResult(normalizedInput, RUST_MIN_EF_SOLVER_VERSION);
  if (earlyResult) return earlyResult;
  const supplyForecast = activeSupplyForecastContext();
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
    rememberLastMinEfPolicy(
      minEfPolicyCacheKey({
        horizonFactor: RUST_PRODUCT_HORIZON_FACTOR,
        input: normalizedInput,
        memoTier: solver.memoTier(),
        normPower: RUST_PRODUCT_NORM_POWER,
        supplyForecast,
        tolerance: RUST_PRODUCT_TOLERANCE,
      }),
      policy,
    );
    const { root, candidates } = policy;
    if (!root.firstAction) {
      return buildRustNoActionResult(normalizedInput, "현재 보유 키트로 가능한 행동이 없습니다.");
    }

    const actionFor = minEfActionFactory(policy);
    const topCandidates = buildPhase2TopCandidates(
      normalizedInput,
      candidates,
      actionFor,
      supplyForecast.expectedGain,
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
      expectedGain: supplyForecast.expectedGain,
      statsExtras: {
        rustMinEf: {
          horizonFactor: RUST_PRODUCT_HORIZON_FACTOR,
          normPower: RUST_PRODUCT_NORM_POWER,
          expectedCost: root.expectedCost,
          memoTier: solver.memoTier(),
          nodeCount: policy.nodeCount,
        },
        memoryStrategy: RUST_MEMORY_STRATEGY,
        minEfMemoTier: RUST_MIN_EF_MEMO_TIER,
        forecastId: supplyForecast.forecastId,
        forecastProfileId: supplyForecast.forecastProfileId,
        solveMs: elapsedMs(startedAt),
      },
    });
  } catch (error) {
    if (!isMemoFull(error) || options.fallbackToPhase2 === false) throw error;
    await releaseRustMinEfSolverCache();
    if (progress) progress({ phase: "fallback-phase2", scanned: 0, total: 1 });
    const fallback = await solveRustPhase2(input, wasmUrl, progress, {
      initialMemoTier: RUST_PHASE2_FALLBACK_MEMO_TIER,
      retryOnMemoFull: false,
      supplyForecast,
    });
    return withFallbackStats(fallback, startedAt, error.nodeCount);
  }
}

export async function solveRustMinEf(
  input: SolverInput,
  wasmUrl: string,
  progress?: (progress: { phase: string; scanned?: number; total?: number | null }) => void,
) {
  return solveRustMinEfProduct(input, wasmUrl, progress, { fallbackToPhase2: false });
}

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function elapsedMs(startedAt: number) {
  return Math.max(0, Math.round((nowMs() - startedAt) * 100) / 100);
}

function withFallbackStats(result: unknown, startedAt: number, attemptedStates: number | null) {
  if (!result || typeof result !== "object") return result;
  const record = result as { stats?: Record<string, unknown> };
  return {
    ...record,
    stats: {
      ...(record.stats || {}),
      fallbackFrom: "rust-min-ef",
      fallbackReason: "memo_full",
      ...(attemptedStates === null ? {} : { attemptedStates }),
      memoryStrategy: RUST_MEMORY_STRATEGY,
      minEfMemoTier: RUST_MIN_EF_MEMO_TIER,
      solveMs: elapsedMs(startedAt),
    },
  };
}
