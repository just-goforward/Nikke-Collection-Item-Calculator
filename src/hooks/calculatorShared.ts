import { EXPECTED_28_DAY_GAIN, FIXED_REQUIRED_EXP } from "../solver";
import type { CollectionState, Grade, Kit, SolverInput, Stock, Strategy } from "../types";
import type { DetailView, ResultView, ValidationView } from "../ui-types";

export const EMPTY_RESULT: ResultView = {
  type: "empty",
  message: "입력값을 넣고 계산을 실행하세요.",
};

export const EMPTY_DETAIL: DetailView = {
  type: "empty",
  message: "계산 후 선택 근거와 검산 결과가 표시됩니다.",
};

export const INITIAL_VALIDATION: ValidationView = {
  buttonLabel: "니붕이들 시켜보기",
  disabled: false,
  message: "검산을 실행하면 SR 15 성공률이 여기에 표시됩니다.",
};

export const DEFAULT_LOADING_TEXT = "보유 키트 상태를 MDP로 평가하고 있습니다.";
export const DEFAULT_STOCK_NOTICE = "대성공이 발생했습니다. 보유 키트 수를 직접 수정해 주세요.";
export const KIT_KEYS: Kit[] = ["blue", "purple", "yellow"];

export type RecommendedRun = {
  count: number;
  success: CollectionState;
  fail: CollectionState;
  greatSuccessProbability?: number;
  noGreatSuccessProbability?: number;
};

export type SolverBest = {
  firstAction: Kit;
  firstProbability: number;
  successProbability: number;
  run?: RecommendedRun;
  vector?: Partial<Record<Kit, number>>;
  totalKits?: number;
  maxSuccessProbability?: number;
  probabilityGap?: number;
  pressure?: number;
  supplyCost?: number;
  availabilityCost?: number;
  legacySupplyCost?: number;
  resourceCost?: number;
};

export type SolverCandidate = {
  firstAction: Kit;
  firstProbability: number;
  successProbability: number;
  run?: RecommendedRun;
  vector?: Partial<Record<Kit, number>>;
  totalKits?: number;
  probabilityGap?: number;
  pressure?: number;
  supplyCost?: number;
  availabilityCost?: number;
  legacySupplyCost?: number;
  resourceCost?: number;
};

export type SolverResult = {
  terminal?: boolean;
  possible?: boolean;
  convertOnly?: boolean;
  message?: string;
  input?: SolverInput;
  candidateCount?: number;
  best?: SolverBest;
  stats?: {
    states?: number;
    strategy?: Strategy;
    maxSuccessProbability?: number;
  };
  topCandidates?: SolverCandidate[];
};

export type MonteCarloResult = {
  runs: number;
  completed: number;
  successProbability: number;
};

export type PendingStatsEvent = {
  start: CollectionState;
  kit: Kit;
  recommendedUses: number;
  stockBefore: Stock;
  resultState: CollectionState;
};

export type TerminalSuccessContext = {
  best: SolverBest;
  run: RecommendedRun;
  startSnapshot: CollectionState;
  stockBeforeSnapshot: Stock;
  beforeStock: number;
};

export type StatsEventInput = {
  start: CollectionState;
  kit: Kit;
  recommendedUses: number;
  outcome: "great_success" | "no_great_success";
  successAttempt: number | null;
  stockBefore: Stock;
  stockAfter: Stock;
  resultState: CollectionState;
};

export function makeStatsEvent({
  start,
  kit,
  recommendedUses,
  outcome,
  successAttempt,
  stockBefore,
  stockAfter,
  resultState,
}: StatsEventInput) {
  return {
    kind: "kit_result" as const,
    start,
    kit,
    recommendedUses,
    outcome,
    successAttempt,
    stockBefore,
    stockAfter,
    resultState,
  };
}

function bucketStockPieces(value: number) {
  if (value <= 0) return "0";
  if (value <= 9) return "1_9";
  if (value <= 49) return "10_49";
  if (value <= 99) return "50_99";
  if (value <= 299) return "100_299";
  return "300_plus";
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

  return {
    kind: "solver_diagnostic" as const,
    diagnosticVersion: 1,
    solverVersion: "phase1_availability_pnorm",
    solverPhase: "phase1",
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

export function requiredForGrade(grade: Grade) {
  return FIXED_REQUIRED_EXP[grade];
}

export function sanitizeExpValue(grade: Grade, level: number, value: number) {
  if (level >= 15) return 0;
  const required = requiredForGrade(grade);
  const normalized = Math.floor((Number(value) || 0) / 100) * 100;
  return Math.min(Math.max(0, normalized), required - 100);
}

export function sameState(a?: CollectionState, b?: CollectionState) {
  return Boolean(a && b && a.grade === b.grade && a.level === b.level && a.exp === b.exp);
}

export function stockPiecesForKit(stock: Stock, kit: Kit) {
  return Number(stock[kit] || 0);
}

export function clampStock(stock: Partial<Stock>): Stock {
  return {
    blue: Math.max(0, Math.floor(Number(stock.blue) || 0)),
    purple: Math.max(0, Math.floor(Number(stock.purple) || 0)),
    yellow: Math.max(0, Math.floor(Number(stock.yellow) || 0)),
  };
}

export function makeMonteCarloSeed() {
  if (window.crypto && typeof window.crypto.getRandomValues === "function") {
    const values = new Uint32Array(1);
    window.crypto.getRandomValues(values);
    return values[0] || Date.now();
  }
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

function isMobileRuntime() {
  const userAgent = navigator.userAgent || "";
  const canMatchMedia = typeof window.matchMedia === "function";
  return (
    /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) ||
    (canMatchMedia && window.matchMedia("(pointer: coarse)").matches) ||
    (canMatchMedia && window.matchMedia("(max-width: 760px)").matches)
  );
}

export function monteCarloRuns() {
  return isMobileRuntime() ? 3000 : 12000;
}

export function inputKey(input: SolverInput) {
  return JSON.stringify({
    start: input.start,
    strategy: input.strategy,
    stock: input.stock,
  });
}

export function rememberCache<T>(cache: Map<string, T>, key: string, value: T, limit: number) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const first = cache.keys().next().value;
    if (typeof first !== "string") break;
    cache.delete(first);
  }
  return value;
}
