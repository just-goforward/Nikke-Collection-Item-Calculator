import {
  availabilityCostScore,
  legacySupplyCostScore,
  researchCostScore,
  resourceCostScore,
} from "./cost";
import {
  type CollectionState,
  capStockForState,
  convertState,
  DEFAULT_RESEARCH_COST_MODEL,
  decrementStock,
  isConvertStateNormalized,
  isTerminalNormalized,
  KIT_ORDER,
  type Kit,
  type KitVector,
  memoKey,
  mixVector,
  normalizeState,
  type ProgressCallback,
  pressureScore,
  type ResearchCostModel,
  STRATEGY_META,
  type Strategy,
  totalKits,
  transitionNormalized,
} from "./domain";
import {
  chooseEfficientCandidate,
  createProbabilityGateAudit,
  type ProbabilityGateAudit,
  probabilityToleranceForStrategy,
  recordProbabilityGateDecision,
} from "./gate";
import type { NormalizedSolverInput } from "./input";

export type SolveExecutionOptions = {
  researchCostModel?: ResearchCostModel;
  collectGateAudit?: boolean;
  toleranceOverride?: number;
};

type TransitionEdge = ReturnType<typeof transitionNormalized>;

type MdpNodeValue = {
  successProbability: number;
  maxSuccessProbability: number;
  probabilityGap: number;
  pressure: number;
  vector: KitVector;
  firstAction: Kit | null;
};

type MdpCandidate = MdpNodeValue & {
  firstAction: Kit;
  actionMaxSuccessProbability: number;
  supplyCost: number;
  availabilityCost: number;
  legacySupplyCost: number;
  resourceCost: number;
  edge: TransitionEdge;
};

export type ActionValue = {
  name: string;
  firstAction: Kit;
  firstProbability: number;
  success: CollectionState;
  fail: CollectionState;
  successProbability: number;
  maxSuccessProbability: number;
  probabilityGap: number;
  pressure: number;
  supplyCost: number;
  availabilityCost: number;
  legacySupplyCost: number;
  resourceCost: number;
  vector: KitVector;
  totalKits: number;
};

export type FiniteInventoryMdpResult = MdpNodeValue & {
  states: number;
  dynamicCapReductions: number;
  dynamicCapFallbacks: number;
  gateAudit?: ProbabilityGateAudit;
  actionFor: (state: Partial<CollectionState>, stock: KitVector) => Kit | null;
  valueForAction: (
    state: Partial<CollectionState>,
    stock: KitVector,
    kit: Kit,
  ) => ActionValue | null;
};

const EMPTY_NODE_VALUE: MdpNodeValue = {
  successProbability: 0,
  maxSuccessProbability: 0,
  probabilityGap: 0,
  pressure: 0,
  vector: { blue: 0, purple: 0, yellow: 0 },
  firstAction: null,
};

export function finiteInventoryMdp(
  input: NormalizedSolverInput,
  progress?: ProgressCallback,
  options: SolveExecutionOptions = {},
): FiniteInventoryMdpResult {
  const memo = new Map<number, MdpNodeValue>();
  const policy = new Map<number, Kit | null>();
  const initialUses = input.actualStockUses;
  const initialStockPieces = input.stock;
  const strategy: Strategy = input.strategy;
  const researchCostModel = options.researchCostModel || DEFAULT_RESEARCH_COST_MODEL;
  const probabilityTolerance = probabilityToleranceForStrategy(strategy, options.toleranceOverride);
  const gateAudit = options.collectGateAudit ? createProbabilityGateAudit() : null;
  const capStats = { dynamicCapReductions: 0, dynamicCapFallbacks: 0 };
  let visited = 0;

  function value(state: CollectionState, stock: KitVector): MdpNodeValue {
    const normalized = state;
    if (isTerminalNormalized(normalized)) {
      return {
        ...EMPTY_NODE_VALUE,
        successProbability: 1,
        maxSuccessProbability: 1,
      };
    }

    if (isConvertStateNormalized(normalized)) {
      return value(convertState(), stock);
    }

    stock = capStockForState(normalized, stock, capStats);

    if (stock.blue <= 0 && stock.purple <= 0 && stock.yellow <= 0) {
      return EMPTY_NODE_VALUE;
    }

    const key = memoKey(normalized, stock);
    const memoized = memo.get(key);
    if (memoized) return memoized;
    visited += 1;
    if (progress && visited % 50000 === 0) {
      progress({ phase: "mdp", scanned: visited, total: null });
    }

    const candidates: MdpCandidate[] = [];
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
      candidates.push({
        firstAction: kit,
        successProbability,
        maxSuccessProbability: 0,
        probabilityGap: 0,
        actionMaxSuccessProbability,
        pressure,
        supplyCost,
        availabilityCost,
        legacySupplyCost,
        resourceCost: resourceCostScore(pressure, supplyCost, strategy),
        vector,
        edge,
      });
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
    const selected = best ?? EMPTY_NODE_VALUE;
    memo.set(key, selected);
    policy.set(key, best ? best.firstAction : null);
    return selected;
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
