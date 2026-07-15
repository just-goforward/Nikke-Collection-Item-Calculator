export const SOLVER_DIAGNOSTIC_VERSION = 6 as const;

export const STATS_LOCALES = ["ko", "ja", "en"] as const;
export type StatsLocale = (typeof STATS_LOCALES)[number];

export const SOLVER_EXECUTION_KINDS = ["executed", "cache_hit"] as const;
export type SolverExecutionKind = (typeof SOLVER_EXECUTION_KINDS)[number];

export const LEGACY_STOCK_BUCKETS = ["0", "1_9", "10_49", "50_99", "100_299", "300_plus"] as const;
export const STOCK_BUCKETS = [
  "0",
  "1_49",
  "50_99",
  "100_149",
  "150_199",
  "200_249",
  "250_299",
  "300_349",
  "350_399",
  "400_449",
  "450_499",
  "500_plus",
] as const;
export const RECOMMENDED_USES_BUCKETS = ["1", "2", "3_4", "5_9", "10_14", "15_plus"] as const;
export const CANDIDATE_COUNT_BUCKETS = ["0", "1", "2", "3_plus"] as const;
export const PROBABILITY_GAP_BUCKETS = [
  "0",
  "0_0_1pp",
  "0_1_0_3pp",
  "0_3_0_7pp",
  "0_7_1_0pp",
  "gt_1_0pp",
] as const;
export const RESOURCE_COST_BUCKETS = [
  "0",
  "0_0_05",
  "0_05_0_1",
  "0_1_0_25",
  "0_25_0_5",
  "0_5_1",
  "1_plus",
] as const;
export const TOTAL_EXPECTED_COST_BUCKETS = ["0_49", "50_99", "100_199", "200_399", "400_plus"] as const;
export const BLUE_SHARE_BUCKETS = ["0_30", "30_50", "50_70", "70_90", "90_100"] as const;
export const MIN_AUTONOMY_DAYS_BUCKETS = ["lt_0", "0_3", "3_7", "7_14", "14_28", "28_plus"] as const;
export const NODE_COUNT_BUCKETS = [
  "0",
  "1_99",
  "100_999",
  "1000_9999",
  "10000_99999",
  "100000_499999",
  "500000_999999",
  "1000000_plus",
] as const;
export const SOLVE_MS_BUCKETS = [
  "unknown",
  "0_50",
  "50_100",
  "100_250",
  "250_500",
  "500_1000",
  "1000_2500",
  "2500_5000",
  "5000_plus",
] as const;
export const COMPARISON_BUCKETS = ["yes", "no", "unknown", "not_applicable"] as const;
export const MEMO_TIER_BUCKETS = ["16", "17", "18", "19", "20", "21", "22", "23", "24", "unknown"] as const;
export const RETRY_BUCKETS = ["yes", "no", "unknown"] as const;

export function bucketStockPieces(value: number) {
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

export function bucketRecommendedUses(value: number) {
  if (value <= 1) return "1";
  if (value === 2) return "2";
  if (value <= 4) return "3_4";
  if (value <= 9) return "5_9";
  if (value <= 14) return "10_14";
  return "15_plus";
}

export function bucketCandidateCount(value: number) {
  if (value <= 0) return "0";
  if (value === 1) return "1";
  if (value === 2) return "2";
  return "3_plus";
}

export function bucketProbabilityGap(value: number) {
  if (value <= 0) return "0";
  if (value <= 0.001) return "0_0_1pp";
  if (value <= 0.003) return "0_1_0_3pp";
  if (value <= 0.007) return "0_3_0_7pp";
  if (value <= 0.01) return "0_7_1_0pp";
  return "gt_1_0pp";
}

export function bucketResourceCost(value: number) {
  if (value <= 0) return "0";
  if (value <= 0.05) return "0_0_05";
  if (value <= 0.1) return "0_05_0_1";
  if (value <= 0.25) return "0_1_0_25";
  if (value <= 0.5) return "0_25_0_5";
  if (value <= 1) return "0_5_1";
  return "1_plus";
}

export function bucketTotalExpectedCost(value: number) {
  if (value <= 49) return "0_49";
  if (value <= 99) return "50_99";
  if (value <= 199) return "100_199";
  if (value <= 399) return "200_399";
  return "400_plus";
}

export function bucketBlueShare(value: number) {
  if (value <= 0.3) return "0_30";
  if (value <= 0.5) return "30_50";
  if (value <= 0.7) return "50_70";
  if (value <= 0.9) return "70_90";
  return "90_100";
}

export function bucketMinAutonomyDays(value: number) {
  if (value < 0) return "lt_0";
  if (value <= 3) return "0_3";
  if (value <= 7) return "3_7";
  if (value <= 14) return "7_14";
  if (value <= 28) return "14_28";
  return "28_plus";
}

export function bucketNodeCount(value: number) {
  if (value <= 0) return "0";
  if (value <= 99) return "1_99";
  if (value <= 999) return "100_999";
  if (value <= 9999) return "1000_9999";
  if (value <= 99_999) return "10000_99999";
  if (value <= 499_999) return "100000_499999";
  if (value <= 999_999) return "500000_999999";
  return "1000000_plus";
}

export function bucketSolveMs(value: number) {
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
