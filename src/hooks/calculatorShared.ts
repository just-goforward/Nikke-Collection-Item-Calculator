import { MAX_STOCK_PIECES } from "../../shared/game";
import type { SolverExecutionKind } from "../../shared/statsContract";
import { message } from "../i18n/locale";
import type { SolverBackend } from "../lib/solverRuntime";
import { FIXED_REQUIRED_EXP } from "../solver/domain";
import type {
  CollectionState,
  Grade,
  Kit,
  SolverInput,
  StageReachPoint,
  Stock,
  Strategy,
} from "../types";
import type { DetailView, ResultView, ValidationView } from "../ui-types";
import type { SolverRecoveryTrace } from "./solverRecoveryPolicy";

export const EMPTY_RESULT: ResultView = {
  type: "empty",
  message: message("result.initial"),
};

export const EMPTY_DETAIL: DetailView = {
  type: "empty",
  message: message("detail.initial"),
};

export const INITIAL_VALIDATION: ValidationView = {
  buttonLabel: message("validation.idleButton"),
  disabled: false,
  stageReach: null,
  status: "idle",
  message: message("validation.idle"),
};

export const DEFAULT_LOADING_TEXT = message("result.loadingDefault");
export const DEFAULT_STOCK_NOTICE = message("stock.notice");
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

type SolverCandidate = {
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
    solverBackend?: string;
    fallbackFrom?: string;
    fallbackReason?: string;
    workerErrorCode?: string;
    memoryStrategy?: string;
    minEfMemoTier?: number;
    phase2MemoTier?: number;
    phase2MemoRetried?: boolean;
    attemptedStates?: number;
    solveMs?: number;
    workerEndToEndMs?: number;
    workerExecutionMs?: number;
    workerLane?: "shared" | "validation";
    workerQueueWaitMs?: number;
  };
  topCandidates?: SolverCandidate[];
};

export type SolveOutcome = {
  executionKind: SolverExecutionKind;
  recoveryTrace?: SolverRecoveryTrace;
  requestedBackend: SolverBackend;
  result: SolverResult;
};

export type MonteCarloResult = {
  runs: number;
  completed: number;
  successProbability: number;
  vector?: Partial<Record<Kit, number>>;
  quantiles?: Record<Kit, { p50: number; p90: number; p95: number }>;
  depletion?: number;
  stageReach?: StageReachPoint[];
  validationPolicyCache?: "hit" | "miss";
  workerTiming?: {
    endToEndMs: number;
    executionMs: number;
    lane: "shared" | "validation";
    queueWaitMs: number;
  };
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
  input: SolverInput;
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
    blue: Math.min(MAX_STOCK_PIECES, Math.max(0, Math.floor(Number(stock.blue) || 0))),
    purple: Math.min(MAX_STOCK_PIECES, Math.max(0, Math.floor(Number(stock.purple) || 0))),
    yellow: Math.min(MAX_STOCK_PIECES, Math.max(0, Math.floor(Number(stock.yellow) || 0))),
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

export function readCache<T>(cache: Map<string, T>, key: string): T | null {
  const value = cache.get(key);
  if (value === undefined) return null;
  cache.delete(key);
  cache.set(key, value);
  return value;
}
