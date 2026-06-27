import { EXPECTED_28_DAY_GAIN } from "../solver/domain";
import type { Kit, Strategy } from "../types";
import { KIT_KEYS, type SolverResult } from "./calculatorShared";

function bucketStockPieces(value: number) {
  if (value <= 0) return "0";
  if (value <= 49) return "1_49";
  if (value <= 99) return "50_99";
  if (value <= 149) return "100_149";
  if (value <= 199) return "150_199";
  if (value <= 249) return "200_249";
  if (value <= 299) return "250_299";
  if (value <= 349) return "300_349";
  if (value <= 399) return "350_399";
  if (value <= 449) return "400_449";
  if (value <= 499) return "450_499";
  return "500_plus";
}

function bucketRecommendedUses(value: number) {
  if (value <= 1) return "1";
  if (value === 2) return "2";
  if (value <= 4) return "3_4";
  if (value <= 9) return "5_9";
  if (value <= 14) return "10_14";
  return "15_plus";
}

function bucketCandidateCount(value: number) {
  if (value <= 0) return "0";
  if (value === 1) return "1";
  if (value === 2) return "2";
  return "3_plus";
}

function bucketProbabilityGap(value: number) {
  if (value <= 0) return "0";
  if (value <= 0.001) return "0_0_1pp";
  if (value <= 0.003) return "0_1_0_3pp";
  if (value <= 0.007) return "0_3_0_7pp";
  if (value <= 0.01) return "0_7_1_0pp";
  return "gt_1_0pp";
}

function bucketResourceCost(value: number) {
  if (value <= 0) return "0";
  if (value <= 0.05) return "0_0_05";
  if (value <= 0.1) return "0_05_0_1";
  if (value <= 0.25) return "0_1_0_25";
  if (value <= 0.5) return "0_25_0_5";
  if (value <= 1) return "0_5_1";
  return "1_plus";
}

function bucketTotalExpectedCost(value: number) {
  if (value <= 49) return "0_49";
  if (value <= 99) return "50_99";
  if (value <= 199) return "100_199";
  if (value <= 399) return "200_399";
  return "400_plus";
}

function bucketBlueShare(value: number) {
  if (value <= 0.3) return "0_30";
  if (value <= 0.5) return "30_50";
  if (value <= 0.7) return "50_70";
  if (value <= 0.9) return "70_90";
  return "90_100";
}

function bucketMinAutonomyDays(value: number) {
  if (value < 0) return "lt_0";
  if (value <= 3) return "0_3";
  if (value <= 7) return "3_7";
  if (value <= 14) return "7_14";
  if (value <= 28) return "14_28";
  return "28_plus";
}

function bucketNodeCount(value: number) {
  if (value <= 0) return "0";
  if (value <= 99) return "1_99";
  if (value <= 999) return "100_999";
  if (value <= 9999) return "1000_9999";
  if (value <= 99_999) return "10000_99999";
  if (value <= 499_999) return "100000_499999";
  if (value <= 999_999) return "500000_999999";
  return "1000000_plus";
}

function bucketSolveMs(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "unknown";
  if (value <= 50) return "0_50";
  if (value <= 100) return "50_100";
  if (value <= 250) return "100_250";
  if (value <= 500) return "250_500";
  if (value <= 1000) return "500_1000";
  if (value <= 2500) return "1000_2500";
  if (value <= 5000) return "2500_5000";
  return "5000_plus";
}

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

export function makeSolverDiagnosticEvent(result: SolverResult) {
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
    diagnosticVersion: 5,
    solverVersion,
    solverPhase,
    solverBackend,
    fallbackFrom: diagnosticToken(stats.fallbackFrom, "none"),
    fallbackReason: diagnosticToken(stats.fallbackReason, "none"),
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
