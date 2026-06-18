import { availabilityCostScore, legacySupplyCostScore } from "../solver/cost";
import {
  isConvertStateNormalized as isConvertState,
  isTerminalNormalized as isTerminal,
  pressureScore,
  round,
  SUPPLY_AVAILABILITY_PARAMS,
  totalKits,
  transition,
} from "../solver/domain";
import type { CollectionState, Kit, SolverInput, Stock } from "../types";
import {
  RUST_PRODUCT_HORIZON_FACTOR,
  RUST_PRODUCT_NORM_POWER,
  RUST_PRODUCT_TOLERANCE,
  RUST_RERANK_FULL_ACCEPT_MARGIN,
  RUST_RERANK_GATE_Z,
  RUST_RERANK_HELD_OUT_SEED,
  RUST_RERANK_MAX_RUNS,
  RUST_RERANK_QUICK_ACCEPT_MARGIN,
  RUST_RERANK_QUICK_RUNS,
  RUST_RERANK_SEED,
  RUST_RERANK_SOLVER_VERSION,
} from "./rustProductConfig";
import {
  normalizeRustProductInput,
  readRustMonteCarloRuns,
  readRustMonteCarloSeed,
} from "./rustProductInput";
import { buildRustEarlyResult, buildRustNoActionResult } from "./rustProductResults";
import { buildFailureRouteWithFirstKit, buildRecommendedRunForKit } from "./rustProductView";
import { selectAdaptiveRerankDecision } from "./rustRerankDecision";
import { getRustPhase2ResearchSolver } from "./rustResearchSolverCache";

const KIT_ORDER: Kit[] = ["blue", "purple", "yellow"];
const STRICT_EPSILON = 1e-12;

export async function solveRustPhase2Rerank(
  input: SolverInput,
  wasmUrl: string,
  progress?: (progress: { phase: string; scanned?: number; total?: number | null }) => void,
) {
  const normalizedInput = normalizeRustProductInput(input);
  if (progress) progress({ phase: "build", scanned: 0, total: 1 });

  const earlyResult = buildRustEarlyResult(normalizedInput, RUST_RERANK_SOLVER_VERSION);
  if (earlyResult) return earlyResult;

  const solver = await getRustPhase2ResearchSolver(wasmUrl);
  const decision = selectAdaptiveRerankDecision(solver, normalizedInput);
  const rerank = decision?.rerank;
  const baselineRoot = rerank?.baseline;
  const selected = decision?.selected;
  const rawSelected = decision?.rawSelected;
  if (!baselineRoot || !selected?.firstAction) {
    return buildRustNoActionResult(normalizedInput, "현재 보유 키트로 가능한 행동이 없습니다.");
  }
  const heldOut = solver.estimateExpectedCostAfterFirstActionFromCurrent(
    normalizedInput.start,
    normalizedInput.stock,
    selected.firstAction,
    RUST_RERANK_MAX_RUNS,
    RUST_RERANK_HELD_OUT_SEED,
    RUST_PRODUCT_HORIZON_FACTOR,
    RUST_PRODUCT_NORM_POWER,
  );
  const heldOutBaseline = baselineRoot.firstAction
    ? baselineRoot.firstAction === selected.firstAction
      ? heldOut
      : solver.estimateExpectedCostAfterFirstActionFromCurrent(
          normalizedInput.start,
          normalizedInput.stock,
          baselineRoot.firstAction,
          RUST_RERANK_MAX_RUNS,
          RUST_RERANK_HELD_OUT_SEED,
          RUST_PRODUCT_HORIZON_FACTOR,
          RUST_PRODUCT_NORM_POWER,
        )
    : null;

  const actionFor = (state: CollectionState, stockUses: Stock) => {
    if (isTerminal(state) || isConvertState(state)) return null;
    return rerank.policy.actionAt(state, stockUses);
  };
  const run = buildRecommendedRunForKit(normalizedInput, actionFor, selected.firstAction);
  const route = buildFailureRouteWithFirstKit(normalizedInput, actionFor, selected.firstAction);
  const edge = transition(normalizedInput.start, selected.firstAction);
  const totalExpectedKits = totalKits(selected.vector);
  const pressure = pressureScore(selected.vector, normalizedInput.stockUses);
  const legacySupplyCost = legacySupplyCostScore(selected.vector);
  const availabilityCost = availabilityCostScore(selected.vector, normalizedInput.stock);
  const monteCarloRuns = readRustMonteCarloRuns(input);
  const monteCarloSeed = readRustMonteCarloSeed(input);
  const monteCarlo =
    monteCarloRuns > 0
      ? solver.simulatePolicyAfterFirstAction(
          normalizedInput.start,
          normalizedInput.stock,
          selected.firstAction,
          monteCarloRuns,
          monteCarloSeed,
          RUST_PRODUCT_HORIZON_FACTOR,
          RUST_PRODUCT_NORM_POWER,
          RUST_PRODUCT_TOLERANCE,
        )
      : {
          runs: 0,
          completed: 0,
          successProbability: selected.successProbability,
          vector: { blue: 0, purple: 0, yellow: 0 },
        };

  if (progress)
    progress({ phase: "done", scanned: baselineRoot.states, total: baselineRoot.states });

  const candidate = {
    name: "Rust phase2 rerank adaptive90 m0.00025 confirm",
    firstAction: selected.firstAction,
    firstProbability: edge.probability,
    run,
    vector: Object.fromEntries(KIT_ORDER.map((kit) => [kit, round(selected.vector[kit], 4)])),
    totalKits: round(totalExpectedKits, 4),
    successProbability: round(selected.successProbability, 8),
    probabilityGap: round(selected.probabilityGap, 8),
    pressure: round(pressure, 8),
    supplyCost: round(legacySupplyCost, 8),
    availabilityCost: round(availabilityCost, 8),
    legacySupplyCost: round(legacySupplyCost, 8),
    resourceCost: round(selected.expectedCost, 8),
    rerankExpectedCost: round(selected.expectedCost, 8),
    rerankCompletionRate: round(selected.completionRate, 8),
  };

  return {
    possible: true,
    terminal: false,
    input: normalizedInput,
    candidateCount: rerank?.candidates.length || 1,
    best: {
      name: "Rust phase2 rerank adaptive90 m0.00025 confirm",
      firstAction: selected.firstAction,
      firstProbability: edge.probability,
      run,
      success: edge.success,
      fail: edge.fail,
      vector: selected.vector,
      totalKits: totalExpectedKits,
      successProbability: selected.successProbability,
      maxSuccessProbability: selected.maxSuccessProbability,
      probabilityGap: selected.probabilityGap,
      pressure,
      supplyCost: legacySupplyCost,
      availabilityCost,
      legacySupplyCost,
      resourceCost: selected.expectedCost,
    },
    route,
    monteCarlo,
    stats: {
      states: baselineRoot.states,
      exact: true,
      tolerance: 0,
      probabilityTolerance: RUST_PRODUCT_TOLERANCE,
      maxSuccessProbability: selected.maxSuccessProbability,
      strategy: "supply",
      solverBackend: "rust-phase2-rerank",
      solverVersion: RUST_RERANK_SOLVER_VERSION,
      solverPhase: "phase2-rerank",
      supplyAvailability: SUPPLY_AVAILABILITY_PARAMS,
      rustRerank: {
        runs: RUST_RERANK_QUICK_RUNS,
        maxRuns: RUST_RERANK_MAX_RUNS,
        seed: RUST_RERANK_SEED,
        gate: "adaptive90",
        gateZ: RUST_RERANK_GATE_Z,
        gateQuickAcceptMargin: RUST_RERANK_QUICK_ACCEPT_MARGIN,
        gateFullAcceptMargin: RUST_RERANK_FULL_ACCEPT_MARGIN,
        gateRuns: decision?.gateRuns ?? null,
        gateSeed: RUST_RERANK_HELD_OUT_SEED,
        gatePass: decision?.gatePass ?? null,
        gateMeanDelta: decision?.gatePair?.meanDelta ?? null,
        gateStandardError: decision?.gatePair?.standardError ?? null,
        gateUpper95: decision?.gatePair?.upper95 ?? null,
        gateUpperBound: decision?.gateUpperBound ?? null,
        gateCorrelation: decision?.gatePair?.correlation ?? null,
        rawSelectedFirstAction: rawSelected?.firstAction ?? null,
        rawExpectedCost: rawSelected?.expectedCost ?? null,
        rawCompletionRate: rawSelected?.completionRate ?? null,
        expectedCost: selected.expectedCost,
        completionRate: selected.completionRate,
        heldOutSeed: RUST_RERANK_HELD_OUT_SEED,
        heldOutExpectedCost: heldOut.expectedCost,
        heldOutCompletionRate: heldOut.completionRate,
        heldOutBaselineExpectedCost: heldOutBaseline?.expectedCost ?? null,
        heldOutBaselineCompletionRate: heldOutBaseline?.completionRate ?? null,
        heldOutDeltaVsBaseline:
          heldOutBaseline && Number.isFinite(heldOutBaseline.expectedCost)
            ? heldOut.expectedCost - heldOutBaseline.expectedCost
            : null,
        heldOutBeatsBaseline:
          heldOutBaseline && Number.isFinite(heldOutBaseline.expectedCost)
            ? heldOut.expectedCost <= heldOutBaseline.expectedCost + STRICT_EPSILON
            : null,
        baselineFirstAction: baselineRoot.firstAction,
        baselineSuccessProbability: baselineRoot.successProbability,
      },
      iterations: 0,
    },
    topCandidates: [candidate],
  };
}
