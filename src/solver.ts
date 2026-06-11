type Grade = "R" | "SR";
const KIT_ORDER = ["blue", "purple", "yellow"] as const;
type Kit = (typeof KIT_ORDER)[number];
type Strategy = "single" | "supply";
type CollectionState = { grade: Grade; level: number; exp: number };
type KitVector = Record<Kit, number>;
type ProgressCallback = (progress: {
  phase: string;
  scanned?: number;
  total?: number | null;
}) => void;
type CapStats = { dynamicCapReductions: number; dynamicCapFallbacks: number };
type ResearchCostModel =
  | {
      kind: "availability-pnorm";
      horizonFactor?: number;
      normPower?: number;
    }
  | { kind: "linear-shadow"; prices: KitVector };
type AvailabilityPnormResearchCostModel = Extract<
  ResearchCostModel,
  { kind: "availability-pnorm" }
>;
type ProbabilityGateWitness = {
  gap: number;
  state: CollectionState;
  stockUses: KitVector;
};
type ProbabilityGateAudit = {
  decisionCount: number;
  maxGap: number;
  maxGapWitness: ProbabilityGateWitness | null;
  violationCount: number;
  firstViolationWitness: ProbabilityGateWitness | null;
  eligibleEmptyCount: number;
  fixedToleranceViolationCount: number;
  firstFixedToleranceViolationWitness: ProbabilityGateWitness | null;
};
type SolveExecutionOptions = {
  researchCostModel?: ResearchCostModel;
  collectGateAudit?: boolean;
  toleranceOverride?: number;
};
// biome-ignore lint/suspicious/noExplicitAny: The legacy solver stores heterogeneous recursive MDP nodes; explicit any keeps strict migration scoped without changing the algorithm.
type AnyValue = any;

const KIT_META: Record<Kit, { label: string; shortLabel: string; exp: number }> = {
  blue: { label: "초심자용 관리 키트", shortLabel: "초심자", exp: 200 },
  purple: { label: "중급자용 관리 키트", shortLabel: "중급자", exp: 500 },
  yellow: { label: "상급자용 관리 키트", shortLabel: "상급자", exp: 1000 },
};

const FIXED_REQUIRED_EXP: Record<Grade, number> = { R: 1000, SR: 3000 };
const MAX_RELEVANT_USES: KitVector = { blue: 220, purple: 88, yellow: 44 };
const STRICT_EPSILON = 1e-12;
const STRATEGY_PROBABILITY_TOLERANCE: Record<Strategy, number> = {
  single: 0.001,
  supply: 0,
};
// Deprecated: kept on CollectionSolver for compatibility with older debug consumers.
const SUPPLY_MODE_WEIGHTS = {
  supply: 0.75,
  stock: 0.25,
};
const SUPPLY_AVAILABILITY_PARAMS = {
  horizon: 0.75,
  normPower: 3,
};
const DEFAULT_RESEARCH_COST_MODEL: AvailabilityPnormResearchCostModel = {
  kind: "availability-pnorm",
};
const EXP_BUCKETS = 30;
const LEVEL_BUCKETS = 16;
const STOCK_ID_SIZE =
  (MAX_RELEVANT_USES.blue + 1) * (MAX_RELEVANT_USES.purple + 1) * (MAX_RELEVANT_USES.yellow + 1);
const WORST_CASE_GUARD_LIMIT = 1000;
const KIT_INDEX: Record<Kit, number> = { blue: 0, purple: 1, yellow: 2 };
const WORST_CASE_USES_CACHE = new Map<number, number>();
const STRATEGY_DEFAULT = "single";
const STRATEGY_META = {
  single: {
    label: "단일 목표",
    description: "지금 이 소장품을 SR 15로 만들기 위한 최적의 선택",
  },
  supply: {
    label: "수급량 고려",
    description: "SR 15 도달 확률과 키트 수급/보유량을 함께 고려하여 최적의 선택지를 제공합니다.",
  },
};
const EXPECTED_28_DAY_GAIN: KitVector = {
  blue: 473.912,
  purple: 55.808,
  yellow: 24.736,
};

const GREAT_SUCCESS: Record<Grade, Record<Kit, Array<number | null>>> = {
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 3) {
  const unit = 10 ** digits;
  return Math.round((value + Number.EPSILON) * unit) / unit;
}

function normalizeState(state?: Partial<CollectionState> | null): CollectionState {
  const grade = state && state.grade === "SR" ? "SR" : "R";
  const rawLevel = Number(state?.level);
  const level = Number.isFinite(rawLevel) ? Math.max(0, Math.floor(rawLevel)) : 0;
  const exp = Math.max(0, Math.floor(Number(state?.exp) || 0));
  if (grade === "SR" && level >= 15) return { grade: "SR", level: 15, exp: 0 };
  if (grade === "R" && level >= 15) return { grade: "R", level: 15, exp: 0 };
  return { grade, level: clamp(level, 0, 14), exp };
}

function isTerminalNormalized(normalized: CollectionState) {
  return normalized.grade === "SR" && normalized.level >= 15;
}

function isConvertStateNormalized(normalized: CollectionState) {
  return normalized.grade === "R" && normalized.level >= 15;
}

function convertState(): CollectionState {
  return { grade: "SR", level: 5, exp: 0 };
}

function nextBoundary(level: number) {
  if (level < 5) return 5;
  if (level < 10) return 10;
  return 15;
}

function failStateNormalized(state: CollectionState, kit: Kit): CollectionState {
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

function transitionNormalized(normalized: CollectionState, kit: Kit) {
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

function transition(state: Partial<CollectionState> | null | undefined, kit: Kit) {
  return transitionNormalized(normalizeState(state), kit);
}

function stateText(state: Partial<CollectionState> | null | undefined) {
  const normalized = normalizeState(state);
  if (normalized.grade === "SR" && normalized.level >= 15) return "SR 15레벨";
  return `${normalized.grade} ${normalized.level}레벨 ${normalized.exp}exp`;
}

function stateIdNormalized(normalized: CollectionState) {
  const gradeId = normalized.grade === "SR" ? 1 : 0;
  return ((gradeId * LEVEL_BUCKETS + normalized.level) * EXP_BUCKETS + normalized.exp / 100) | 0;
}

function stockId(stock: KitVector) {
  return (
    (stock.blue * (MAX_RELEVANT_USES.purple + 1) + stock.purple) * (MAX_RELEVANT_USES.yellow + 1) +
    stock.yellow
  );
}

function memoKey(normalized: CollectionState, stock: KitVector) {
  return stateIdNormalized(normalized) * STOCK_ID_SIZE + stockId(stock);
}

function worstCaseUsesNormalized(start: CollectionState, kit: Kit) {
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

function capStockForState(
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

function normalizeStock(stock?: Partial<KitVector> | null): KitVector {
  return {
    blue: Math.max(0, Math.floor(Number(stock?.blue) || 0)),
    purple: Math.max(0, Math.floor(Number(stock?.purple) || 0)),
    yellow: Math.max(0, Math.floor(Number(stock?.yellow) || 0)),
  };
}

function stockToUses(stock: KitVector): KitVector {
  return {
    blue: Math.floor(stock.blue / 10),
    purple: Math.floor(stock.purple / 10),
    yellow: Math.floor(stock.yellow / 10),
  };
}

function decrementStock(stock: KitVector, kit: Kit): KitVector {
  return {
    blue: stock.blue - (kit === "blue" ? 1 : 0),
    purple: stock.purple - (kit === "purple" ? 1 : 0),
    yellow: stock.yellow - (kit === "yellow" ? 1 : 0),
  };
}

function addUse(vector: KitVector, kit: Kit): KitVector {
  return {
    blue: vector.blue + (kit === "blue" ? 10 : 0),
    purple: vector.purple + (kit === "purple" ? 10 : 0),
    yellow: vector.yellow + (kit === "yellow" ? 10 : 0),
  };
}

function mixVector(probability: number, success: KitVector, fail: KitVector, kit: Kit): KitVector {
  return addUse(
    {
      blue: probability * success.blue + (1 - probability) * fail.blue,
      purple: probability * success.purple + (1 - probability) * fail.purple,
      yellow: probability * success.yellow + (1 - probability) * fail.yellow,
    },
    kit,
  );
}

function totalKits(vector: KitVector) {
  return KIT_ORDER.reduce((sum, kit) => sum + vector[kit], 0);
}

function pressureScore(vector: KitVector, initialUses: KitVector) {
  return KIT_ORDER.reduce((sum, kit) => {
    const base = Math.max(1, initialUses[kit]);
    return sum + vector[kit] / 10 / base;
  }, 0);
}

function legacySupplyCostScore(vector: KitVector) {
  return KIT_ORDER.reduce((sum, kit) => sum + vector[kit] / EXPECTED_28_DAY_GAIN[kit], 0);
}

function availabilityRatio(consumption: number, availability: number) {
  if (availability > 0) return consumption / availability;
  return consumption > STRICT_EPSILON ? Number.POSITIVE_INFINITY : 0;
}

function availabilityCostScoreWithParams(
  vector: KitVector,
  stockPieces: KitVector,
  model: AvailabilityPnormResearchCostModel = DEFAULT_RESEARCH_COST_MODEL,
) {
  // Supply Phase 1 heuristic:
  // R_i = current stock pieces_i + horizon * expected 28-day gain_i
  // cost = (sum((expected consumption_i / R_i) ^ p)) ^ (1 / p)
  //
  // This is deterministic and stable for each memoized (state, stock), but it is not a proof of
  // global whole-route p-norm optimality. The memoized continuation is parent-independent, so
  // prior route consumption is not part of the state. If this approximation becomes a real
  // problem in benchmark data, the practical refinement path is shadow-price fixed-point passes,
  // not expanding the MDP state with cumulative consumption.
  const horizonFactor =
    typeof model.horizonFactor === "number" && Number.isFinite(model.horizonFactor)
      ? Math.max(0, model.horizonFactor)
      : SUPPLY_AVAILABILITY_PARAMS.horizon;
  const normPower = model.normPower ?? SUPPLY_AVAILABILITY_PARAMS.normPower;
  const ratios = KIT_ORDER.map((kit) =>
    availabilityRatio(vector[kit], stockPieces[kit] + horizonFactor * EXPECTED_28_DAY_GAIN[kit]),
  );

  if (normPower === Number.POSITIVE_INFINITY) return Math.max(...ratios);
  if (!Number.isFinite(normPower) || normPower <= 0) return Number.POSITIVE_INFINITY;

  const powered = ratios.reduce((sum, ratio) => {
    return sum + ratio ** normPower;
  }, 0);
  return powered ** (1 / normPower);
}

function availabilityCostScore(vector: KitVector, stockPieces: KitVector) {
  return availabilityCostScoreWithParams(vector, stockPieces);
}

function researchCostScore(vector: KitVector, stockPieces: KitVector, model: ResearchCostModel) {
  if (model.kind === "availability-pnorm")
    return availabilityCostScoreWithParams(vector, stockPieces, model);
  return KIT_ORDER.reduce((sum, kit) => {
    const price = Number(model.prices[kit]);
    if (!Number.isFinite(price) || price < 0) return Number.POSITIVE_INFINITY;
    return sum + price * vector[kit];
  }, 0);
}

function resourceCostScore(pressure: number, supplyCost: number, strategy: Strategy) {
  if (strategy !== "supply") return pressure;
  return supplyCost;
}

function createProbabilityGateAudit(): ProbabilityGateAudit {
  return {
    decisionCount: 0,
    maxGap: 0,
    maxGapWitness: null,
    violationCount: 0,
    firstViolationWitness: null,
    eligibleEmptyCount: 0,
    fixedToleranceViolationCount: 0,
    firstFixedToleranceViolationWitness: null,
  };
}

function recordProbabilityGateDecision(
  audit: ProbabilityGateAudit,
  gap: number,
  tolerance: number,
  eligibleEmpty: boolean,
  state: CollectionState,
  stockUses: KitVector,
) {
  audit.decisionCount += 1;
  if (eligibleEmpty) audit.eligibleEmptyCount += 1;
  if (gap > audit.maxGap) {
    audit.maxGap = gap;
    audit.maxGapWitness = { gap, state: { ...state }, stockUses: { ...stockUses } };
  }
  if (gap > tolerance + STRICT_EPSILON) {
    audit.violationCount += 1;
    if (!audit.firstViolationWitness) {
      audit.firstViolationWitness = { gap, state: { ...state }, stockUses: { ...stockUses } };
    }
  }
  if (gap > STRATEGY_PROBABILITY_TOLERANCE.supply + STRICT_EPSILON) {
    audit.fixedToleranceViolationCount += 1;
    if (!audit.firstFixedToleranceViolationWitness) {
      audit.firstFixedToleranceViolationWitness = {
        gap,
        state: { ...state },
        stockUses: { ...stockUses },
      };
    }
  }
}

function normalizeStrategy(strategy: unknown): Strategy {
  return strategy === "supply" ? "supply" : STRATEGY_DEFAULT;
}

function probabilityToleranceForStrategy(strategy: unknown, toleranceOverride?: number) {
  const normalized = normalizeStrategy(strategy);
  if (
    normalized === "supply" &&
    typeof toleranceOverride === "number" &&
    Number.isFinite(toleranceOverride) &&
    toleranceOverride >= 0
  ) {
    return toleranceOverride;
  }
  return STRATEGY_PROBABILITY_TOLERANCE[normalized];
}

function withinProbabilityTolerance(
  successProbability: number,
  maxSuccessProbability: number,
  strategy: unknown,
  toleranceOverride?: number,
) {
  return (
    maxSuccessProbability - successProbability <=
    probabilityToleranceForStrategy(strategy, toleranceOverride) + STRICT_EPSILON
  );
}

function compareEfficiency(a: AnyValue, b: AnyValue, strategy: Strategy = STRATEGY_DEFAULT) {
  if (strategy === "supply") {
    if (Math.abs(a.resourceCost - b.resourceCost) > STRICT_EPSILON)
      return a.resourceCost - b.resourceCost;
  } else if (Math.abs(a.pressure - b.pressure) > STRICT_EPSILON) {
    return a.pressure - b.pressure;
  }
  const totalDiff = totalKits(a.vector) - totalKits(b.vector);
  if (Math.abs(totalDiff) > STRICT_EPSILON) return totalDiff;
  return b.successProbability - a.successProbability;
}

function chooseEfficientCandidate(
  candidates: AnyValue[],
  maxSuccessProbability: number,
  strategy: Strategy,
  toleranceOverride?: number,
) {
  if (!candidates.length) return { best: null, eligibleEmpty: false };
  const eligible = candidates.filter((candidate) =>
    withinProbabilityTolerance(
      candidate.successProbability,
      maxSuccessProbability,
      strategy,
      toleranceOverride,
    ),
  );
  const pool = eligible.length ? eligible : candidates;
  const best = pool.reduce((currentBest, candidate) => {
    if (!currentBest) return candidate;
    return compareEfficiency(candidate, currentBest, strategy) < 0 ? candidate : currentBest;
  }, null);
  return { best, eligibleEmpty: eligible.length === 0 };
}

function compareByStrategy(
  a: AnyValue,
  b: AnyValue,
  maxSuccessProbability: number,
  strategy: Strategy,
  toleranceOverride?: number,
) {
  const aEligible = withinProbabilityTolerance(
    a.successProbability,
    maxSuccessProbability,
    strategy,
    toleranceOverride,
  );
  const bEligible = withinProbabilityTolerance(
    b.successProbability,
    maxSuccessProbability,
    strategy,
    toleranceOverride,
  );
  if (aEligible !== bEligible) return aEligible ? -1 : 1;
  if (aEligible && bEligible) return compareEfficiency(a, b, strategy);
  if (Math.abs(a.successProbability - b.successProbability) > STRICT_EPSILON) {
    return b.successProbability - a.successProbability;
  }
  return compareEfficiency(a, b, strategy);
}

function finiteInventoryMdp(
  input: AnyValue,
  progress?: ProgressCallback,
  options: SolveExecutionOptions = {},
) {
  const memo = new Map<number, AnyValue>();
  const policy = new Map<number, Kit | null>();
  const initialUses = input.actualStockUses || input.stockUses;
  const initialStockPieces = input.stock || {
    blue: initialUses.blue * 10,
    purple: initialUses.purple * 10,
    yellow: initialUses.yellow * 10,
  };
  const strategy = normalizeStrategy(input.strategy);
  const researchCostModel = options.researchCostModel || DEFAULT_RESEARCH_COST_MODEL;
  const probabilityTolerance = probabilityToleranceForStrategy(strategy, options.toleranceOverride);
  const gateAudit = options.collectGateAudit ? createProbabilityGateAudit() : null;
  const capStats = { dynamicCapReductions: 0, dynamicCapFallbacks: 0 };
  let visited = 0;

  function value(state: CollectionState, stock: KitVector): AnyValue {
    const normalized = state;
    if (isTerminalNormalized(normalized)) {
      return {
        successProbability: 1,
        maxSuccessProbability: 1,
        probabilityGap: 0,
        pressure: 0,
        vector: { blue: 0, purple: 0, yellow: 0 },
        firstAction: null,
      };
    }

    if (isConvertStateNormalized(normalized)) {
      return value(convertState(), stock);
    }

    stock = capStockForState(normalized, stock, capStats);

    if (stock.blue <= 0 && stock.purple <= 0 && stock.yellow <= 0) {
      return {
        successProbability: 0,
        maxSuccessProbability: 0,
        probabilityGap: 0,
        pressure: 0,
        vector: { blue: 0, purple: 0, yellow: 0 },
        firstAction: null,
      };
    }

    const key = memoKey(normalized, stock);
    if (memo.has(key)) return memo.get(key);
    visited += 1;
    if (progress && visited % 50000 === 0) {
      progress({ phase: "mdp", scanned: visited, total: null });
    }

    const candidates: AnyValue[] = [];
    let maxSuccessProbability = 0;
    for (const kit of KIT_ORDER) {
      if (stock[kit] <= 0) continue;
      const nextStock = decrementStock(stock, kit);
      const edge = transitionNormalized(normalized, kit);
      const success = value(edge.success, nextStock);
      const fail = value(edge.fail, nextStock);
      const vector = mixVector(edge.probability, success.vector, fail.vector, kit);
      const successProbability =
        edge.probability * success.successProbability +
        (1 - edge.probability) * fail.successProbability;
      const actionMaxSuccessProbability =
        edge.probability * success.maxSuccessProbability +
        (1 - edge.probability) * fail.maxSuccessProbability;
      if (actionMaxSuccessProbability > maxSuccessProbability) {
        maxSuccessProbability = actionMaxSuccessProbability;
      }
      const pressure = pressureScore(vector, initialUses);
      const availabilityCost = availabilityCostScore(vector, initialStockPieces);
      const supplyCost = researchCostScore(vector, initialStockPieces, researchCostModel);
      const legacySupplyCost = legacySupplyCostScore(vector);
      const candidate = {
        firstAction: kit,
        successProbability,
        actionMaxSuccessProbability,
        pressure,
        supplyCost,
        availabilityCost,
        legacySupplyCost,
        resourceCost: resourceCostScore(pressure, supplyCost, strategy),
        vector,
        edge,
      };
      candidates.push(candidate);
    }

    for (const candidate of candidates) {
      candidate.maxSuccessProbability = maxSuccessProbability;
      candidate.probabilityGap = Math.max(0, maxSuccessProbability - candidate.successProbability);
    }
    const { best, eligibleEmpty } = chooseEfficientCandidate(
      candidates,
      maxSuccessProbability,
      strategy,
      probabilityTolerance,
    );
    if (gateAudit && best) {
      recordProbabilityGateDecision(
        gateAudit,
        Math.max(0, maxSuccessProbability - best.successProbability),
        probabilityTolerance,
        eligibleEmpty,
        normalized,
        stock,
      );
    }
    memo.set(key, best);
    policy.set(key, best ? best.firstAction : null);
    return best;
  }

  const startValue = value(input.start, input.stockUses);
  return {
    ...startValue,
    states: memo.size,
    dynamicCapReductions: capStats.dynamicCapReductions,
    dynamicCapFallbacks: capStats.dynamicCapFallbacks,
    ...(gateAudit ? { gateAudit } : {}),
    actionFor: (state: Partial<CollectionState>, stock: KitVector) => {
      const normalized = normalizeState(state);
      const cappedStock = capStockForState(normalized, stock);
      return policy.get(memoKey(normalized, cappedStock)) || null;
    },
    valueForAction: (state: Partial<CollectionState>, stock: KitVector, kit: Kit) => {
      const normalized = normalizeState(state);
      const cappedStock = capStockForState(normalized, stock);
      if (cappedStock[kit] <= 0) return null;
      const stateValue = value(normalized, cappedStock);
      const edge = transitionNormalized(normalized, kit);
      const nextStock = decrementStock(cappedStock, kit);
      const success = value(edge.success, nextStock);
      const fail = value(edge.fail, nextStock);
      const vector = mixVector(edge.probability, success.vector, fail.vector, kit);
      const successProbability =
        edge.probability * success.successProbability +
        (1 - edge.probability) * fail.successProbability;
      const maxSuccessProbability = stateValue
        ? stateValue.maxSuccessProbability
        : successProbability;
      const pressure = pressureScore(vector, initialUses);
      const availabilityCost = availabilityCostScore(vector, initialStockPieces);
      const supplyCost = researchCostScore(vector, initialStockPieces, researchCostModel);
      const legacySupplyCost = legacySupplyCostScore(vector);
      return {
        name: STRATEGY_META[strategy].label,
        firstAction: kit,
        firstProbability: edge.probability,
        success: edge.success,
        fail: edge.fail,
        successProbability,
        maxSuccessProbability,
        probabilityGap: Math.max(0, maxSuccessProbability - successProbability),
        pressure,
        supplyCost,
        availabilityCost,
        legacySupplyCost,
        resourceCost: resourceCostScore(pressure, supplyCost, strategy),
        vector,
        totalKits: totalKits(vector),
      };
    },
  };
}

function buildFailureRoute(input: AnyValue, actionFor: AnyValue, limit = 8) {
  const route: AnyValue[] = [];
  let state = normalizeState(input.start);
  let stock = { ...input.stockUses };

  for (let index = 0; index < limit; index += 1) {
    if (isTerminalNormalized(state)) break;
    if (isConvertStateNormalized(state)) {
      route.push({
        state: stateText(state),
        kit: "convert",
        probability: 1,
        success: stateText(convertState()),
        fail: stateText(convertState()),
        stockBefore: { ...stock },
      });
      state = convertState();
      continue;
    }
    const kit = actionFor(state, stock);
    if (!kit || stock[kit] <= 0) break;
    const edge = transitionNormalized(state, kit);
    route.push({
      state: stateText(state),
      kit,
      probability: edge.probability,
      success: stateText(edge.success),
      fail: stateText(edge.fail),
      stockBefore: { ...stock },
    });
    stock = decrementStock(stock, kit);
    state = edge.fail;
  }

  return route;
}

function buildRecommendedRun(input: AnyValue, actionFor: AnyValue, limit = 100) {
  const kit = actionFor(normalizeState(input.start), { ...input.stockUses });
  return buildRecommendedRunForKit(input, actionFor, kit, limit);
}

function buildRecommendedRunForKit(
  input: AnyValue,
  actionFor: AnyValue,
  kit: Kit | null,
  limit = 100,
) {
  let state = normalizeState(input.start);
  let stock = { ...input.stockUses };
  if (!kit || stock[kit] <= 0) return null;

  const firstEdge = transitionNormalized(state, kit);
  const successTarget = firstEdge.success;
  let count = 0;
  let noGreatSuccessProbability = 1;

  while (
    count < limit &&
    !isTerminalNormalized(state) &&
    !isConvertStateNormalized(state) &&
    stock[kit] > 0
  ) {
    if (count > 0) {
      const nextKit = actionFor(state, stock);
      if (nextKit !== kit) break;
    }
    const edge = transitionNormalized(state, kit);
    if (stateIdNormalized(edge.success) !== stateIdNormalized(successTarget)) break;
    count += 1;
    noGreatSuccessProbability *= 1 - edge.probability;
    stock = decrementStock(stock, kit);
    const fail = edge.fail;
    const leveledUp = fail.grade !== state.grade || fail.level !== state.level;
    state = fail;
    if (leveledUp) break;
  }

  return {
    kit,
    count,
    success: successTarget,
    fail: state,
    greatSuccessProbability: 1 - noGreatSuccessProbability,
    noGreatSuccessProbability,
  };
}

function makeRandom(seed: number) {
  let value = seed >>> 0;
  return function random() {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function simulate(input: AnyValue, actionFor: AnyValue, runs = 12000, seed = 20260505) {
  const random = makeRandom(seed);
  const totals = { blue: 0, purple: 0, yellow: 0 };
  const hist: Record<Kit, number[]> = {
    blue: new Array(256).fill(0),
    purple: new Array(256).fill(0),
    yellow: new Array(256).fill(0),
  };
  let completed = 0;

  for (let run = 0; run < runs; run += 1) {
    let state = normalizeState(input.start);
    let stock = { ...input.stockUses };
    const used = { blue: 0, purple: 0, yellow: 0 };

    for (let step = 0; step < 1000; step += 1) {
      if (isTerminalNormalized(state)) {
        completed += 1;
        break;
      }
      if (isConvertStateNormalized(state)) {
        state = convertState();
        continue;
      }
      const kit = actionFor(state, stock) as Kit | null;
      if (!kit || stock[kit] <= 0) break;
      stock = decrementStock(stock, kit);
      used[kit] += 10;
      const edge = transitionNormalized(state, kit);
      state = random() < edge.probability ? edge.success : edge.fail;
    }

    for (const kit of KIT_ORDER) {
      totals[kit] += used[kit];
      hist[kit][Math.min(255, Math.floor(used[kit] / 10))] += 1;
    }
  }

  const quantileUses = (kit: Kit, q: number) => {
    if (runs <= 0) return 0;
    const threshold = clamp(Math.trunc(q * runs), 1, runs);
    let cumulative = 0;
    for (let uses = 0; uses < hist[kit].length; uses += 1) {
      cumulative += hist[kit][uses];
      if (cumulative >= threshold) return uses;
    }
    return hist[kit].length - 1;
  };
  const kitQuantiles = (kit: Kit) => ({
    p50: quantileUses(kit, 0.5) * 10,
    p90: quantileUses(kit, 0.9) * 10,
    p95: quantileUses(kit, 0.95) * 10,
  });

  return {
    runs,
    completed,
    successProbability: runs > 0 ? completed / runs : 0,
    vector: {
      blue: runs > 0 ? totals.blue / runs : 0,
      purple: runs > 0 ? totals.purple / runs : 0,
      yellow: runs > 0 ? totals.yellow / runs : 0,
    },
    quantiles: {
      blue: kitQuantiles("blue"),
      purple: kitQuantiles("purple"),
      yellow: kitQuantiles("yellow"),
    },
    depletion: runs > 0 ? (runs - completed) / runs : 0,
  };
}

function normalizeInput(input: AnyValue) {
  const grade = input.start && input.start.grade === "SR" ? "SR" : "R";
  const required = FIXED_REQUIRED_EXP[grade];
  const exp = clamp(Math.floor((Number(input.start?.exp) || 0) / 100) * 100, 0, required - 100);
  const stock = normalizeStock(input.stock || {});
  const actualStockUses = stockToUses(stock);

  return {
    start: normalizeState({
      grade,
      level: input.start ? input.start.level : 0,
      exp,
    }),
    strategy: normalizeStrategy(input.strategy),
    stock,
    actualStockUses,
    stockUses: {
      blue: Math.min(actualStockUses.blue, MAX_RELEVANT_USES.blue),
      purple: Math.min(actualStockUses.purple, MAX_RELEVANT_USES.purple),
      yellow: Math.min(actualStockUses.yellow, MAX_RELEVANT_USES.yellow),
    },
    requiredExp: FIXED_REQUIRED_EXP,
  };
}

function solveInternal(
  input: AnyValue,
  progress?: ProgressCallback,
  options: SolveExecutionOptions = {},
): AnyValue {
  const normalizedInput = normalizeInput(input);
  const probabilityTolerance = probabilityToleranceForStrategy(
    normalizedInput.strategy,
    options.toleranceOverride,
  );
  const monteCarloRuns = Math.max(0, Math.floor(Number(input?.monteCarloRuns) || 0));
  const monteCarloSeed = Math.max(0, Math.floor(Number(input?.monteCarloSeed) || 20260505));
  if (progress) progress({ phase: "build", scanned: 0, total: 1 });

  if (isTerminalNormalized(normalizedInput.start)) {
    return {
      terminal: true,
      input: normalizedInput,
      message: "이미 SR 15레벨입니다.",
    };
  }

  if (isConvertStateNormalized(normalizedInput.start)) {
    return {
      possible: true,
      convertOnly: true,
      input: normalizedInput,
      best: {
        name: "등급 전환",
        firstAction: "convert",
        firstProbability: 1,
        success: convertState(),
        fail: convertState(),
        vector: { blue: 0, purple: 0, yellow: 0 },
        totalKits: 0,
        successProbability: 1,
        pressure: 0,
      },
      route: [],
      monteCarlo: {
        runs: 0,
        completed: 0,
        successProbability: 1,
        vector: { blue: 0, purple: 0, yellow: 0 },
      },
      stats: {
        states: 0,
        exact: true,
        tolerance: 0,
        iterations: 0,
      },
      topCandidates: [],
    };
  }

  const totalUses =
    normalizedInput.stockUses.blue +
    normalizedInput.stockUses.purple +
    normalizedInput.stockUses.yellow;
  if (totalUses <= 0) {
    return {
      possible: false,
      input: normalizedInput,
      message: "사용 가능한 키트가 없습니다. 각 키트는 10개 단위로만 사용할 수 있습니다.",
    };
  }

  const mdp = finiteInventoryMdp(normalizedInput, progress, options);
  const bestAction = mdp.firstAction;
  if (!bestAction) {
    return {
      possible: false,
      input: normalizedInput,
      message: "현재 보유 키트로 가능한 행동이 없습니다.",
    };
  }

  const actionValues = KIT_ORDER.map((kit) =>
    mdp.valueForAction(normalizedInput.start, normalizedInput.stockUses, kit),
  )
    .filter(Boolean)
    .sort((a, b) =>
      compareByStrategy(
        a,
        b,
        mdp.maxSuccessProbability,
        normalizedInput.strategy,
        probabilityTolerance,
      ),
    );

  const best =
    actionValues.find((candidate) => candidate.firstAction === bestAction) || actionValues[0];
  const run = buildRecommendedRun(normalizedInput, mdp.actionFor);
  const route = buildFailureRoute(normalizedInput, mdp.actionFor);
  const monteCarlo =
    monteCarloRuns > 0
      ? simulate(normalizedInput, mdp.actionFor, monteCarloRuns, monteCarloSeed)
      : {
          runs: 0,
          completed: 0,
          successProbability: best.successProbability,
          vector: { blue: 0, purple: 0, yellow: 0 },
        };
  if (progress) progress({ phase: "done", scanned: 1, total: 1 });

  return {
    possible: true,
    terminal: false,
    input: normalizedInput,
    candidateCount: actionValues.length,
    best: {
      name: "보유량 유한 MDP",
      firstAction: best.firstAction,
      firstProbability: best.firstProbability,
      run,
      success: best.success,
      fail: best.fail,
      vector: best.vector,
      totalKits: best.totalKits,
      successProbability: best.successProbability,
      maxSuccessProbability: best.maxSuccessProbability,
      probabilityGap: best.probabilityGap,
      pressure: best.pressure,
      supplyCost: best.supplyCost,
      availabilityCost: best.availabilityCost,
      legacySupplyCost: best.legacySupplyCost,
      resourceCost: best.resourceCost,
    },
    route,
    monteCarlo,
    stats: {
      states: mdp.states,
      exact: true,
      tolerance: 0,
      probabilityTolerance,
      maxSuccessProbability: mdp.maxSuccessProbability,
      dynamicCapReductions: mdp.dynamicCapReductions,
      dynamicCapFallbacks: mdp.dynamicCapFallbacks,
      ...(mdp.gateAudit ? { gateAudit: mdp.gateAudit } : {}),
      strategy: normalizedInput.strategy,
      supplyAvailability: SUPPLY_AVAILABILITY_PARAMS,
      iterations: 0,
    },
    topCandidates: actionValues.map((candidate) => ({
      name: candidate.name,
      firstAction: candidate.firstAction,
      run: buildRecommendedRunForKit(normalizedInput, mdp.actionFor, candidate.firstAction),
      vector: Object.fromEntries(KIT_ORDER.map((kit) => [kit, round(candidate.vector[kit], 4)])),
      totalKits: round(candidate.totalKits, 4),
      successProbability: round(candidate.successProbability, 8),
      probabilityGap: round(candidate.probabilityGap, 8),
      pressure: round(candidate.pressure, 8),
      supplyCost: round(candidate.supplyCost, 8),
      availabilityCost: round(candidate.availabilityCost, 8),
      legacySupplyCost: round(candidate.legacySupplyCost, 8),
      resourceCost: round(candidate.resourceCost, 8),
    })),
  };
}

function solve(input: AnyValue, progress?: ProgressCallback): AnyValue {
  return solveInternal(input, progress);
}

function solveWithResearchCostModel(
  input: AnyValue,
  model: ResearchCostModel = DEFAULT_RESEARCH_COST_MODEL,
  progress?: ProgressCallback,
  options: Omit<SolveExecutionOptions, "researchCostModel"> = {},
): AnyValue {
  return solveInternal(input, progress, {
    researchCostModel: model,
    collectGateAudit: options.collectGateAudit ?? true,
    toleranceOverride: options.toleranceOverride,
  });
}

const CollectionSolver = {
  KIT_ORDER,
  KIT_META,
  FIXED_REQUIRED_EXP,
  MAX_RELEVANT_USES,
  STRATEGY_PROBABILITY_TOLERANCE,
  SUPPLY_MODE_WEIGHTS,
  SUPPLY_AVAILABILITY_PARAMS,
  STRATEGY_META,
  EXPECTED_28_DAY_GAIN,
  GREAT_SUCCESS,
  nextBoundary,
  transition,
  normalizeState,
  convertState,
  describeState: stateText,
  solve,
  solveWithResearchCostModel,
  round,
};

export {
  convertState,
  EXPECTED_28_DAY_GAIN,
  FIXED_REQUIRED_EXP,
  GREAT_SUCCESS,
  KIT_META,
  KIT_ORDER,
  MAX_RELEVANT_USES,
  nextBoundary,
  normalizeState,
  type ProbabilityGateAudit,
  type ProbabilityGateWitness,
  type ResearchCostModel,
  round,
  type SolveExecutionOptions,
  STRATEGY_META,
  STRATEGY_PROBABILITY_TOLERANCE,
  SUPPLY_AVAILABILITY_PARAMS,
  SUPPLY_MODE_WEIGHTS,
  solve,
  solveWithResearchCostModel,
  stateText as describeState,
  transition,
};

export default CollectionSolver;
