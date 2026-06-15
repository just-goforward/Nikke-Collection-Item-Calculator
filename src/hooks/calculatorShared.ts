import { FIXED_REQUIRED_EXP } from "../solver/domain";
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
  successDistribution: null,
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
    probabilityTolerance?: number;
    solverVersion?: string;
    solverPhase?: string;
  };
  topCandidates?: SolverCandidate[];
};

export type MonteCarloResult = {
  runs: number;
  completed: number;
  successProbability: number;
  vector?: Partial<Record<Kit, number>>;
  quantiles?: Record<Kit, { p50: number; p90: number; p95: number }>;
  depletion?: number;
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
