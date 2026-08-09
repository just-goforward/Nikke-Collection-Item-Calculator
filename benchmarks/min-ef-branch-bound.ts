import { researchCostScore } from "../src/solver/cost";
import {
  type CollectionState,
  convertState,
  isConvertStateNormalized,
  isTerminalNormalized,
  KIT_ORDER,
  type Kit,
  type KitVector,
  STRICT_EPSILON,
  stateIdNormalized,
  transitionNormalized,
} from "../src/solver/domain";

export type TinyMinEfOptions = {
  horizonFactor?: number;
  normPower?: number;
  tolerance?: number;
};

export type TinyMinEfCandidate = {
  action: Kit;
  success: number;
  maxSuccess: number;
  expectedCost: number;
  lowerBound: number;
  vector: KitVector;
  eligible: boolean;
};

export type TinyMinEfNode = {
  action: Kit | null;
  success: number;
  maxSuccess: number;
  expectedCost: number;
  vector: KitVector;
  candidates: TinyMinEfCandidate[];
};

export type TinyMinEfStats = {
  memoStates: number;
  nonterminalStates: number;
  eligibleActions: number;
  canonicalPrunableActions: number;
  bestFirstPrunableActions: number;
  boundViolations: number;
};

export type TinyMinEfResult = {
  root: TinyMinEfNode;
  stats: TinyMinEfStats;
};

type UsesState = {
  state: CollectionState;
  stock: KitVector;
};

type ResolvedOptions = Required<TinyMinEfOptions>;

const ZERO_VECTOR: KitVector = { blue: 0, purple: 0, yellow: 0 };

export function immediateConsumptionLowerBound(
  initialStockPieces: KitVector,
  startUses: KitVector,
  remainingUses: KitVector,
  action: Kit,
  options: TinyMinEfOptions = {},
): number {
  const consumed = consumedPieces(startUses, remainingUses);
  consumed[action] += 10;
  return availabilityCost(consumed, initialStockPieces, resolveOptions(options));
}

export function enumerateTinyMinEf(
  start: CollectionState,
  initialStockPieces: KitVector,
  options: TinyMinEfOptions = {},
): TinyMinEfResult {
  const resolved = resolveOptions(options);
  const startUses: KitVector = {
    blue: Math.floor(initialStockPieces.blue / 10),
    purple: Math.floor(initialStockPieces.purple / 10),
    yellow: Math.floor(initialStockPieces.yellow / 10),
  };
  const memo = new Map<string, TinyMinEfNode>();
  const stats: TinyMinEfStats = {
    memoStates: 0,
    nonterminalStates: 0,
    eligibleActions: 0,
    canonicalPrunableActions: 0,
    bestFirstPrunableActions: 0,
    boundViolations: 0,
  };

  const value = ({ state, stock }: UsesState): TinyMinEfNode => {
    const key = tinyStateKey(state, stock);
    const cached = memo.get(key);
    if (cached) return cached;

    if (isTerminalNormalized(state)) {
      const terminal = leafNode(1, startUses, stock, initialStockPieces, resolved);
      memo.set(key, terminal);
      return terminal;
    }
    if (isConvertStateNormalized(state)) {
      const converted = value({ state: convertState(), stock });
      memo.set(key, converted);
      return converted;
    }

    const candidates: TinyMinEfCandidate[] = [];
    for (const action of KIT_ORDER) {
      if (stock[action] <= 0) continue;
      const edge = transitionNormalized(state, action);
      const nextStock = decrement(stock, action);
      const success = value({ state: edge.success, stock: nextStock });
      const failure = value({ state: edge.fail, stock: nextStock });
      const candidate = combineCandidate(
        edge.probability,
        action,
        success,
        failure,
        immediateConsumptionLowerBound(initialStockPieces, startUses, stock, action, resolved),
      );
      candidates.push(candidate);
    }

    if (candidates.length === 0) {
      const depleted = leafNode(0, startUses, stock, initialStockPieces, resolved);
      memo.set(key, depleted);
      return depleted;
    }

    const maximum = Math.max(...candidates.map((candidate) => candidate.maxSuccess));
    for (const candidate of candidates) {
      candidate.eligible = maximum - candidate.success <= resolved.tolerance + STRICT_EPSILON;
    }
    const eligible = candidates.filter((candidate) => candidate.eligible);
    const selectable = eligible.length > 0 ? eligible : candidates;
    const best = selectable.reduce((incumbent, candidate) =>
      better(candidate, incumbent) ? candidate : incumbent,
    );

    stats.nonterminalStates += 1;
    stats.eligibleActions += selectable.length;
    for (const candidate of selectable) {
      if (candidate.lowerBound > candidate.expectedCost + STRICT_EPSILON) {
        stats.boundViolations += 1;
      }
      if (
        candidate.action !== best.action &&
        candidate.lowerBound > best.expectedCost + STRICT_EPSILON
      ) {
        stats.bestFirstPrunableActions += 1;
      }
    }
    let incumbentCost = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (!candidate.eligible && eligible.length > 0) continue;
      if (candidate.lowerBound > incumbentCost + STRICT_EPSILON) {
        stats.canonicalPrunableActions += 1;
        continue;
      }
      incumbentCost = Math.min(incumbentCost, candidate.expectedCost);
    }

    const node: TinyMinEfNode = {
      action: best.action,
      success: best.success,
      maxSuccess: maximum,
      expectedCost: best.expectedCost,
      vector: best.vector,
      candidates,
    };
    memo.set(key, node);
    return node;
  };

  const root = value({ state: start, stock: startUses });
  stats.memoStates = memo.size;
  return { root, stats };
}

function combineCandidate(
  probability: number,
  action: Kit,
  success: TinyMinEfNode,
  failure: TinyMinEfNode,
  lowerBound: number,
): TinyMinEfCandidate {
  const inverse = 1 - probability;
  return {
    action,
    success: probability * success.success + inverse * failure.success,
    maxSuccess: probability * success.maxSuccess + inverse * failure.maxSuccess,
    expectedCost: probability * success.expectedCost + inverse * failure.expectedCost,
    lowerBound,
    vector: {
      blue:
        probability * success.vector.blue +
        inverse * failure.vector.blue +
        Number(action === "blue") * 10,
      purple:
        probability * success.vector.purple +
        inverse * failure.vector.purple +
        Number(action === "purple") * 10,
      yellow:
        probability * success.vector.yellow +
        inverse * failure.vector.yellow +
        Number(action === "yellow") * 10,
    },
    eligible: false,
  };
}

function leafNode(
  success: number,
  startUses: KitVector,
  remainingUses: KitVector,
  initialStockPieces: KitVector,
  options: ResolvedOptions,
): TinyMinEfNode {
  return {
    action: null,
    success,
    maxSuccess: success,
    expectedCost: availabilityCost(
      consumedPieces(startUses, remainingUses),
      initialStockPieces,
      options,
    ),
    vector: ZERO_VECTOR,
    candidates: [],
  };
}

function better(candidate: TinyMinEfCandidate, incumbent: TinyMinEfCandidate): boolean {
  const costDelta = candidate.expectedCost - incumbent.expectedCost;
  if (Math.abs(costDelta) > STRICT_EPSILON) return costDelta < 0;
  const totalDelta = total(candidate.vector) - total(incumbent.vector);
  if (Math.abs(totalDelta) > STRICT_EPSILON) return totalDelta < 0;
  return candidate.success > incumbent.success;
}

function availabilityCost(
  consumed: KitVector,
  initialStockPieces: KitVector,
  options: ResolvedOptions,
): number {
  return researchCostScore(consumed, initialStockPieces, {
    kind: "availability-pnorm",
    horizonFactor: options.horizonFactor,
    normPower: options.normPower,
  });
}

function consumedPieces(startUses: KitVector, remainingUses: KitVector): KitVector {
  return {
    blue: (startUses.blue - remainingUses.blue) * 10,
    purple: (startUses.purple - remainingUses.purple) * 10,
    yellow: (startUses.yellow - remainingUses.yellow) * 10,
  };
}

function decrement(stock: KitVector, action: Kit): KitVector {
  return {
    blue: stock.blue - Number(action === "blue"),
    purple: stock.purple - Number(action === "purple"),
    yellow: stock.yellow - Number(action === "yellow"),
  };
}

function total(vector: KitVector): number {
  return vector.blue + vector.purple + vector.yellow;
}

function tinyStateKey(state: CollectionState, stock: KitVector): string {
  return `${stateIdNormalized(state)}:${stock.blue}:${stock.purple}:${stock.yellow}`;
}

function resolveOptions(options: TinyMinEfOptions): ResolvedOptions {
  return {
    horizonFactor: options.horizonFactor ?? 0.75,
    normPower: options.normPower ?? 3,
    tolerance: options.tolerance ?? 0,
  };
}
