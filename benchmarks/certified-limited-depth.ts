import { researchCostScore } from "../src/solver/cost";
import {
  convertState,
  isConvertStateNormalized,
  isTerminalNormalized,
  KIT_ORDER,
  MAX_RELEVANT_USES,
  normalizeState,
  STRICT_EPSILON,
  transitionNormalized,
} from "../src/solver/domain";
import type { CollectionState, Kit, Stock } from "../src/types";
import { type CompactStockUses, stateStockKey } from "./compact-exact-graph";

export type ValueInterval = {
  successLower: number;
  successUpper: number;
  costLower: number;
  costUpper: number;
};

export type RootActionInterval = ValueInterval & { action: Kit };

export type CertifiedLimitedDepthResult = {
  outcome: "completed" | "numeric_ambiguous" | "budget_exceeded";
  selectedAction: Kit | null;
  root: ValueInterval;
  candidates: RootActionInterval[];
  expandedStates: number;
  depthLimit: number;
};

export function solveCertifiedLimitedDepth(input: {
  start: CollectionState;
  stock: Stock;
  depthLimit: number;
  stateBudget?: number;
  horizonFactor?: number;
  normPower?: number;
  tolerance?: number;
}): CertifiedLimitedDepthResult {
  const depthLimit = Math.max(0, Math.trunc(input.depthLimit));
  const stateBudget = Math.max(1, Math.trunc(input.stateBudget ?? 1_200_000));
  const horizonFactor = input.horizonFactor ?? 0.75;
  const normPower = input.normPower ?? 3;
  const tolerance = input.tolerance ?? 0;
  const initialUses = boundedUses(input.stock);
  const memo = new Map<string, ValueInterval>();
  let expandedStates = 0;
  let budgetExceeded = false;

  const leafCost = (stock: CompactStockUses) => {
    const consumed: Stock = {
      blue: (initialUses.blue - stock.blue) * 10,
      purple: (initialUses.purple - stock.purple) * 10,
      yellow: (initialUses.yellow - stock.yellow) * 10,
    };
    return researchCostScore(consumed, input.stock, {
      kind: "availability-pnorm",
      horizonFactor,
      normPower,
    });
  };
  const maximumLeafCost = (stock: CompactStockUses) => {
    const maximumConsumed: Stock = {
      blue: initialUses.blue * 10,
      purple: initialUses.purple * 10,
      yellow: initialUses.yellow * 10,
    };
    const current = leafCost(stock);
    const maximum = researchCostScore(maximumConsumed, input.stock, {
      kind: "availability-pnorm",
      horizonFactor,
      normPower,
    });
    return Math.max(current, maximum);
  };

  const visit = (
    rawState: CollectionState,
    stock: CompactStockUses,
    remainingDepth: number,
  ): ValueInterval => {
    const state = isConvertStateNormalized(rawState) ? convertState() : rawState;
    if (isTerminalNormalized(state)) {
      const cost = leafCost(stock);
      return { successLower: 1, successUpper: 1, costLower: cost, costUpper: cost };
    }
    if (stock.blue + stock.purple + stock.yellow === 0) {
      const cost = leafCost(stock);
      return { successLower: 0, successUpper: 0, costLower: cost, costUpper: cost };
    }
    if (remainingDepth <= 0) {
      return {
        successLower: 0,
        successUpper: 1,
        costLower: leafCost(stock),
        costUpper: maximumLeafCost(stock),
      };
    }
    const memoKey = `${stateStockKey(state, stock)}:${remainingDepth}`;
    const cached = memo.get(memoKey);
    if (cached) return cached;
    if (expandedStates >= stateBudget) {
      budgetExceeded = true;
      return {
        successLower: 0,
        successUpper: 1,
        costLower: leafCost(stock),
        costUpper: maximumLeafCost(stock),
      };
    }
    expandedStates += 1;
    const candidates = actionIntervals(state, stock, remainingDepth, visit);
    const interval = combineOptimalIntervals(candidates, tolerance);
    memo.set(memoKey, interval);
    return interval;
  };

  const start = normalizeState(input.start);
  const rootState = isConvertStateNormalized(start) ? convertState() : start;
  const candidates = actionIntervals(rootState, initialUses, depthLimit, visit);
  const root = combineOptimalIntervals(candidates, tolerance);
  const selectedAction = budgetExceeded ? null : certifyRootAction(candidates, tolerance);
  return {
    outcome: budgetExceeded
      ? "budget_exceeded"
      : selectedAction
        ? "completed"
        : "numeric_ambiguous",
    selectedAction,
    root,
    candidates,
    expandedStates,
    depthLimit,
  };
}

function actionIntervals(
  state: CollectionState,
  stock: CompactStockUses,
  remainingDepth: number,
  visit: (state: CollectionState, stock: CompactStockUses, remainingDepth: number) => ValueInterval,
): RootActionInterval[] {
  const candidates: RootActionInterval[] = [];
  for (const action of KIT_ORDER) {
    if (stock[action] <= 0) continue;
    const edge = transitionNormalized(state, action);
    const nextStock = decrement(stock, action);
    const success = visit(edge.success, nextStock, remainingDepth - 1);
    const failure = visit(edge.fail, nextStock, remainingDepth - 1);
    const inverse = 1 - edge.probability;
    candidates.push({
      action,
      successLower: edge.probability * success.successLower + inverse * failure.successLower,
      successUpper: edge.probability * success.successUpper + inverse * failure.successUpper,
      costLower: edge.probability * success.costLower + inverse * failure.costLower,
      costUpper: edge.probability * success.costUpper + inverse * failure.costUpper,
    });
  }
  return candidates;
}

function combineOptimalIntervals(
  candidates: readonly RootActionInterval[],
  tolerance: number,
): ValueInterval {
  if (candidates.length === 0) {
    throw new Error("Non-terminal limited-depth state has no available action.");
  }
  const successLower = Math.max(...candidates.map((candidate) => candidate.successLower));
  const successUpper = Math.max(...candidates.map((candidate) => candidate.successUpper));
  const possiblyEligible = candidates.filter(
    (candidate) => candidate.successUpper >= successLower - tolerance - STRICT_EPSILON,
  );
  return {
    successLower,
    successUpper,
    costLower: Math.min(...possiblyEligible.map((candidate) => candidate.costLower)),
    costUpper: Math.min(...possiblyEligible.map((candidate) => candidate.costUpper)),
  };
}

function certifyRootAction(
  candidates: readonly RootActionInterval[],
  tolerance: number,
): Kit | null {
  if (candidates.length === 0) return null;
  for (const candidate of candidates) {
    const otherUpper = Math.max(
      Number.NEGATIVE_INFINITY,
      ...candidates
        .filter((other) => other.action !== candidate.action)
        .map((other) => other.successUpper),
    );
    if (candidate.successLower > otherUpper + tolerance + STRICT_EPSILON) {
      return candidate.action;
    }
  }

  const successIsExact = candidates.every(
    (candidate) => candidate.successUpper - candidate.successLower <= STRICT_EPSILON,
  );
  if (!successIsExact) return null;
  const maximum = Math.max(...candidates.map((candidate) => candidate.successLower));
  const eligible = candidates.filter(
    (candidate) => maximum - candidate.successLower <= tolerance + STRICT_EPSILON,
  );
  for (const candidate of eligible) {
    if (
      eligible.every(
        (other) =>
          other.action === candidate.action ||
          candidate.costUpper < other.costLower - STRICT_EPSILON,
      )
    ) {
      return candidate.action;
    }
  }
  return null;
}

function boundedUses(stock: Stock): CompactStockUses {
  return {
    blue: Math.min(MAX_RELEVANT_USES.blue, Math.max(0, Math.floor(stock.blue / 10))),
    purple: Math.min(MAX_RELEVANT_USES.purple, Math.max(0, Math.floor(stock.purple / 10))),
    yellow: Math.min(MAX_RELEVANT_USES.yellow, Math.max(0, Math.floor(stock.yellow / 10))),
  };
}

function decrement(stock: CompactStockUses, action: Kit): CompactStockUses {
  return {
    blue: stock.blue - (action === "blue" ? 1 : 0),
    purple: stock.purple - (action === "purple" ? 1 : 0),
    yellow: stock.yellow - (action === "yellow" ? 1 : 0),
  };
}
