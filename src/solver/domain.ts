export type Grade = "R" | "SR";
export const KIT_ORDER = ["blue", "purple", "yellow"] as const;
export type Kit = (typeof KIT_ORDER)[number];
export type Strategy = "single" | "supply";
export type CollectionState = { grade: Grade; level: number; exp: number };
export type KitVector = Record<Kit, number>;
export type ProgressCallback = (progress: {
  phase: string;
  scanned?: number;
  total?: number | null;
}) => void;
export type CapStats = { dynamicCapReductions: number; dynamicCapFallbacks: number };
export type ResearchCostModel =
  | {
      kind: "availability-pnorm";
      horizonFactor?: number;
      normPower?: number;
    }
  | { kind: "linear-shadow"; prices: KitVector };
export type AvailabilityPnormResearchCostModel = Extract<
  ResearchCostModel,
  { kind: "availability-pnorm" }
>;

export const KIT_META: Record<Kit, { label: string; shortLabel: string; exp: number }> = {
  blue: { label: "초심자용 관리 키트", shortLabel: "초심자", exp: 200 },
  purple: { label: "중급자용 관리 키트", shortLabel: "중급자", exp: 500 },
  yellow: { label: "상급자용 관리 키트", shortLabel: "상급자", exp: 1000 },
};

export const FIXED_REQUIRED_EXP: Record<Grade, number> = { R: 1000, SR: 3000 };
export const MAX_RELEVANT_USES: KitVector = { blue: 220, purple: 88, yellow: 44 };
export const STRICT_EPSILON = 1e-12;
export const STRATEGY_PROBABILITY_TOLERANCE: Record<Strategy, number> = {
  single: 0.001,
  supply: 0,
};
// Deprecated: kept on CollectionSolver for compatibility with older debug consumers.
export const SUPPLY_MODE_WEIGHTS = {
  supply: 0.75,
  stock: 0.25,
};
export const SUPPLY_AVAILABILITY_PARAMS = {
  horizon: 0.75,
  normPower: 3,
};
export const DEFAULT_RESEARCH_COST_MODEL: AvailabilityPnormResearchCostModel = {
  kind: "availability-pnorm",
};
const EXP_BUCKETS = 30;
const LEVEL_BUCKETS = 16;
const STOCK_ID_SIZE =
  (MAX_RELEVANT_USES.blue + 1) * (MAX_RELEVANT_USES.purple + 1) * (MAX_RELEVANT_USES.yellow + 1);
const WORST_CASE_GUARD_LIMIT = 1000;
const KIT_INDEX: Record<Kit, number> = { blue: 0, purple: 1, yellow: 2 };
const WORST_CASE_USES_CACHE = new Map<number, number>();
export const STRATEGY_DEFAULT = "single";
export const STRATEGY_META = {
  single: {
    label: "단일 목표",
    description: "지금 이 소장품을 SR 15로 만들기 위한 최적의 선택",
  },
  supply: {
    label: "수급량 고려",
    description: "SR 15 도달 확률과 키트 수급/보유량을 함께 고려하여 최적의 선택지를 제공합니다.",
  },
};
export const EXPECTED_28_DAY_GAIN: KitVector = {
  blue: 473.912,
  purple: 55.808,
  yellow: 24.736,
};

export const GREAT_SUCCESS: Record<Grade, Record<Kit, Array<number | null>>> = {
  R: {
    blue: [
      17.6, 20.8, 24.0, 27.2, 40.0, 16.0, 19.2, 22.4, 27.2, 40.0, 14.4, 17.6, 22.4, 27.2, 40.0,
    ],
    purple: [
      55.0, 65.0, 75.0, 85.0, 100.0, 50.0, 60.0, 70.0, 85.0, 100.0, 45.0, 55.0, 70.0, 85.0, 100.0,
    ],
    yellow: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
  },
  SR: {
    blue: [3.6, 5.9, 7.8, 11.3, 15.0, 2.2, 3.3, 4.9, 7.6, 12.5, 1.2, 2.2, 3.1, 4.7, 10.0],
    purple: [11.0, 19.8, 28.7, 41.3, 55.0, 8.0, 12.0, 18.0, 28.0, 50.0, 5.4, 9.9, 14.4, 21.6, 45.0],
    yellow: [
      25.0, 40.0, 55.0, 75.0, 100.0, 20.0, 30.0, 45.0, 70.0, 100.0, 15.0, 27.5, 40.0, 60.0, 100.0,
    ],
  },
};

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 3) {
  const unit = 10 ** digits;
  return Math.round((value + Number.EPSILON) * unit) / unit;
}

export function normalizeState(state?: Partial<CollectionState> | null): CollectionState {
  const grade = state && state.grade === "SR" ? "SR" : "R";
  const rawLevel = Number(state?.level);
  const level = Number.isFinite(rawLevel) ? Math.max(0, Math.floor(rawLevel)) : 0;
  const exp = Math.max(0, Math.floor(Number(state?.exp) || 0));
  if (grade === "SR" && level >= 15) return { grade: "SR", level: 15, exp: 0 };
  if (grade === "R" && level >= 15) return { grade: "R", level: 15, exp: 0 };
  return { grade, level: clamp(level, 0, 14), exp };
}

export function isTerminalNormalized(normalized: CollectionState) {
  return normalized.grade === "SR" && normalized.level >= 15;
}

export function isConvertStateNormalized(normalized: CollectionState) {
  return normalized.grade === "R" && normalized.level >= 15;
}

export function convertState(): CollectionState {
  return { grade: "SR", level: 5, exp: 0 };
}

export function nextBoundary(level: number) {
  if (level < 5) return 5;
  if (level < 10) return 10;
  return 15;
}

export function failStateNormalized(state: CollectionState, kit: Kit): CollectionState {
  const grade = state.grade;
  let level = state.level;
  let exp = state.exp + KIT_META[kit].exp;
  const required = FIXED_REQUIRED_EXP[grade];

  while (exp >= required && level < 15) {
    exp -= required;
    level += 1;
    if (level === 5 || level === 10 || level === 15) {
      exp = 0;
      break;
    }
  }
  return { grade, level, exp };
}

export function transitionNormalized(normalized: CollectionState, kit: Kit) {
  if (isTerminalNormalized(normalized) || isConvertStateNormalized(normalized)) {
    return { probability: 0, success: normalized, fail: normalized };
  }
  const probability = Number(GREAT_SUCCESS[normalized.grade][kit][normalized.level] || 0) / 100;
  return {
    probability,
    success: {
      grade: normalized.grade,
      level: nextBoundary(normalized.level),
      exp: 0,
    },
    fail: failStateNormalized(normalized, kit),
  };
}

export function transition(state: Partial<CollectionState> | null | undefined, kit: Kit) {
  return transitionNormalized(normalizeState(state), kit);
}

export function stateText(state: Partial<CollectionState> | null | undefined) {
  const normalized = normalizeState(state);
  if (normalized.grade === "SR" && normalized.level >= 15) return "SR 15레벨";
  return `${normalized.grade} ${normalized.level}레벨 ${normalized.exp}exp`;
}

export function stateIdNormalized(normalized: CollectionState) {
  const gradeId = normalized.grade === "SR" ? 1 : 0;
  return ((gradeId * LEVEL_BUCKETS + normalized.level) * EXP_BUCKETS + normalized.exp / 100) | 0;
}

export function stockId(stock: KitVector) {
  return (
    (stock.blue * (MAX_RELEVANT_USES.purple + 1) + stock.purple) * (MAX_RELEVANT_USES.yellow + 1) +
    stock.yellow
  );
}

export function memoKey(normalized: CollectionState, stock: KitVector) {
  return stateIdNormalized(normalized) * STOCK_ID_SIZE + stockId(stock);
}

export function worstCaseUsesNormalized(start: CollectionState, kit: Kit) {
  const key = stateIdNormalized(start) * KIT_ORDER.length + KIT_INDEX[kit];
  const cached = WORST_CASE_USES_CACHE.get(key);
  if (typeof cached === "number") return cached;

  let state = start;
  let count = 0;
  let guard = 0;
  while (!isTerminalNormalized(state)) {
    guard += 1;
    if (guard > WORST_CASE_GUARD_LIMIT) {
      return Number.POSITIVE_INFINITY;
    }
    if (isConvertStateNormalized(state)) {
      state = convertState();
      continue;
    }
    state = failStateNormalized(state, kit);
    count += 1;
  }

  WORST_CASE_USES_CACHE.set(key, count);
  return count;
}

export function capStockForState(
  normalized: CollectionState,
  stock: KitVector,
  stats: CapStats | null = null,
) {
  const caps: KitVector = {
    blue: worstCaseUsesNormalized(normalized, "blue"),
    purple: worstCaseUsesNormalized(normalized, "purple"),
    yellow: worstCaseUsesNormalized(normalized, "yellow"),
  };
  if (
    !Number.isFinite(caps.blue) ||
    !Number.isFinite(caps.purple) ||
    !Number.isFinite(caps.yellow)
  ) {
    if (stats) stats.dynamicCapFallbacks += 1;
    return stock;
  }

  const capped: KitVector = {
    blue: Math.min(stock.blue, caps.blue),
    purple: Math.min(stock.purple, caps.purple),
    yellow: Math.min(stock.yellow, caps.yellow),
  };
  const originalTotal = stock.blue + stock.purple + stock.yellow;
  const cappedTotal = capped.blue + capped.purple + capped.yellow;
  if (originalTotal > 0 && cappedTotal <= 0) {
    if (stats) stats.dynamicCapFallbacks += 1;
    return stock;
  }
  if (
    capped.blue === stock.blue &&
    capped.purple === stock.purple &&
    capped.yellow === stock.yellow
  )
    return stock;
  if (stats) stats.dynamicCapReductions += originalTotal - cappedTotal;
  return capped;
}

export function normalizeStock(stock?: Partial<KitVector> | null): KitVector {
  return {
    blue: Math.max(0, Math.floor(Number(stock?.blue) || 0)),
    purple: Math.max(0, Math.floor(Number(stock?.purple) || 0)),
    yellow: Math.max(0, Math.floor(Number(stock?.yellow) || 0)),
  };
}

export function stockToUses(stock: KitVector): KitVector {
  return {
    blue: Math.floor(stock.blue / 10),
    purple: Math.floor(stock.purple / 10),
    yellow: Math.floor(stock.yellow / 10),
  };
}

export function decrementStock(stock: KitVector, kit: Kit): KitVector {
  return {
    blue: stock.blue - (kit === "blue" ? 1 : 0),
    purple: stock.purple - (kit === "purple" ? 1 : 0),
    yellow: stock.yellow - (kit === "yellow" ? 1 : 0),
  };
}

export function addUse(vector: KitVector, kit: Kit): KitVector {
  return {
    blue: vector.blue + (kit === "blue" ? 10 : 0),
    purple: vector.purple + (kit === "purple" ? 10 : 0),
    yellow: vector.yellow + (kit === "yellow" ? 10 : 0),
  };
}

export function mixVector(
  probability: number,
  success: KitVector,
  fail: KitVector,
  kit: Kit,
): KitVector {
  return addUse(
    {
      blue: probability * success.blue + (1 - probability) * fail.blue,
      purple: probability * success.purple + (1 - probability) * fail.purple,
      yellow: probability * success.yellow + (1 - probability) * fail.yellow,
    },
    kit,
  );
}

export function totalKits(vector: KitVector) {
  return KIT_ORDER.reduce((sum, kit) => sum + vector[kit], 0);
}

export function pressureScore(vector: KitVector, initialUses: KitVector) {
  return KIT_ORDER.reduce((sum, kit) => {
    const base = Math.max(1, initialUses[kit]);
    return sum + vector[kit] / 10 / base;
  }, 0);
}
