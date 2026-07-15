import {
  bucketBlueShare,
  bucketCandidateCount,
  bucketMinAutonomyDays,
  bucketNodeCount,
  bucketProbabilityGap,
  bucketRecommendedUses,
  bucketResourceCost,
  bucketSolveMs,
  bucketStockPieces,
  bucketTotalExpectedCost,
  SOLVER_DIAGNOSTIC_VERSION,
  type StatsLocale,
} from "../../shared/statsContract";
import { EXPECTED_28_DAY_GAIN } from "../solver/domain";
import type { Kit, Strategy } from "../types";
import { RUST_MIN_EF_MEMO_TIER, RUST_PHASE2_FALLBACK_MEMO_TIER } from "../wasm/rustProductConfig";
import { KIT_KEYS, type SolveOutcome } from "./calculatorShared";
import type { SolverRecoveryTrace } from "./solverRecoveryPolicy";

function diagnosticToken(value: unknown, fallback = "unknown") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function booleanDiagnosticToken(value: unknown, fallback = "unknown") {
  if (value === true) return "yes";
  if (value === false) return "no";
  return fallback;
}

function tierDiagnosticToken(value: unknown, fallback = "unknown") {
  const tier = Math.trunc(Number(value));
  if (!Number.isFinite(tier)) return fallback;
  if (tier < 16 || tier > 24) return fallback;
  return String(tier);
}

function vectorValue(vector: Partial<Record<Kit, number>> | undefined, kit: Kit) {
  return Math.max(0, Number(vector?.[kit] || 0));
}

export function makeSolverDiagnosticEvent(outcome: SolveOutcome, locale: StatsLocale) {
  const { executionKind, requestedBackend, result } = outcome;
  if (!result.possible || !result.input || !result.best) return null;
  const input = result.input;
  const best = result.best;
  const runCount = Math.max(1, Math.trunc(Number(best.run?.count || 1)));
  const vector = best.vector || {};
  const totalExpectedCost =
    Number(best.totalKits) || KIT_KEYS.reduce((sum, kit) => sum + vectorValue(vector, kit), 0);
  if (!Number.isFinite(totalExpectedCost) || totalExpectedCost <= 0) return null;

  const blueShare = vectorValue(vector, "blue") / totalExpectedCost;
  const minAutonomyDays = KIT_KEYS.reduce((minimum, kit) => {
    const dailyGain = EXPECTED_28_DAY_GAIN[kit] / 28;
    const remainingDays = (Number(input.stock[kit] || 0) - vectorValue(vector, kit)) / dailyGain;
    return Math.min(minimum, remainingDays);
  }, Number.POSITIVE_INFINITY);
  const maxSuccessProbability =
    Number(best.maxSuccessProbability ?? result.stats?.maxSuccessProbability) ||
    best.successProbability;
  const probabilityGap = Math.max(
    0,
    Number(best.probabilityGap ?? maxSuccessProbability - best.successProbability) || 0,
  );
  // This field is kept for diagnostic schema compatibility. It is no longer a user choice.
  const strategy: Strategy = "supply";
  const stats = result.stats || {};
  const solverVersion =
    typeof stats.solverVersion === "string"
      ? stats.solverVersion
      : "phase2_availability_h075_tau0_p3";
  const solverPhase = typeof stats.solverPhase === "string" ? stats.solverPhase : "phase2";
  const solverBackend = diagnosticToken(stats.solverBackend, "js-phase2");

  return {
    kind: "solver_diagnostic" as const,
    diagnosticVersion: SOLVER_DIAGNOSTIC_VERSION,
    locale,
    executionKind,
    requestedBackend,
    solverVersion,
    solverPhase,
    solverBackend,
    fallbackFrom: diagnosticToken(stats.fallbackFrom, "none"),
    fallbackReason: diagnosticToken(stats.fallbackReason, "none"),
    workerErrorCode: diagnosticToken(stats.workerErrorCode, "none"),
    memoryStrategy: diagnosticToken(stats.memoryStrategy, "unknown"),
    minEfMemoTier: tierDiagnosticToken(stats.minEfMemoTier),
    phase2MemoTier: tierDiagnosticToken(stats.phase2MemoTier),
    phase2MemoRetried: booleanDiagnosticToken(stats.phase2MemoRetried),
    start: input.start,
    strategy,
    stockBuckets: {
      blue: bucketStockPieces(input.stock.blue),
      purple: bucketStockPieces(input.stock.purple),
      yellow: bucketStockPieces(input.stock.yellow),
    },
    recommendedKit: best.firstAction,
    recommendedUsesBucket: bucketRecommendedUses(runCount),
    candidateCountBucket: bucketCandidateCount(
      result.candidateCount || result.topCandidates?.length || 0,
    ),
    probabilityGapBucket: bucketProbabilityGap(probabilityGap),
    resourceCostBucket: bucketResourceCost(Number(best.resourceCost || 0)),
    nodeCountBucket: bucketNodeCount(Number(stats.states || 0)),
    attemptedNodeCountBucket: bucketNodeCount(Number(stats.attemptedStates ?? stats.states ?? 0)),
    solveMsBucket: bucketSolveMs(Number(stats.solveMs || 0)),
    legacySupplyCostBucket: bucketResourceCost(Number(best.legacySupplyCost || 0)),
    totalExpectedCostBucket: bucketTotalExpectedCost(totalExpectedCost),
    blueShareBucket: bucketBlueShare(blueShare),
    minAutonomyDaysBucket: bucketMinAutonomyDays(minAutonomyDays),
    changedFromSingle: "unknown",
    changedFromLegacySupply: "unknown",
    legacyPrivateStatsAvailable: false,
    legacyEventAggregateMatchable: true,
  };
}

export function makeSolverRecoveryEvent(
  input: SolveOutcome["result"]["input"],
  trace: SolverRecoveryTrace | undefined,
) {
  if (!input || !trace || !hasRecoverySignal(trace)) return null;
  return {
    kind: "solver_recovery" as const,
    recoveryVersion: 1 as const,
    policyVersion: trace.policyVersion,
    requestedBackend: trace.requestedBackend,
    minEfExit: trace.minEfExit,
    phase2Exit: trace.phase2Exit,
    jsExit: trace.jsExit,
    terminalBackend: trace.terminalBackend,
    terminalOutcome: trace.terminalOutcome,
    minEfMemoTier: String(RUST_MIN_EF_MEMO_TIER),
    phase2MemoTier: String(RUST_PHASE2_FALLBACK_MEMO_TIER),
    start: input.start,
    stockBuckets: {
      blue: bucketStockPieces(input.stock.blue),
      purple: bucketStockPieces(input.stock.purple),
      yellow: bucketStockPieces(input.stock.yellow),
    },
  };
}

function hasRecoverySignal(trace: SolverRecoveryTrace) {
  return (
    trace.terminalOutcome === "failure" ||
    trace.terminalBackend !== trace.requestedBackend ||
    [trace.minEfExit, trace.phase2Exit, trace.jsExit].some(
      (exit) => exit !== "not_attempted" && exit !== "success",
    )
  );
}
