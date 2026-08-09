import { researchCostScore } from "../src/solver/cost";
import {
  convertState,
  EXPECTED_28_DAY_GAIN,
  isConvertStateNormalized,
  isTerminalNormalized,
  KIT_ORDER,
  MAX_RELEVANT_USES,
  normalizeState,
  STRICT_EPSILON,
  stateIdNormalized,
  transitionNormalized,
} from "../src/solver/domain";
import type { CollectionState, Kit, Stock } from "../src/types";

const EXP_BUCKETS = 30;
const LEVEL_BUCKETS = 16;
const STATE_BUCKETS = 2 * LEVEL_BUCKETS * EXP_BUCKETS;
const PURPLE_DIM = MAX_RELEVANT_USES.purple + 1;
const YELLOW_DIM = MAX_RELEVANT_USES.yellow + 1;
const STOCK_ID_SIZE = (MAX_RELEVANT_USES.blue + 1) * PURPLE_DIM * YELLOW_DIM;
const KIT_INDEX: Record<Kit, number> = { blue: 0, purple: 1, yellow: 2 };

export type CompactStockUses = { blue: number; purple: number; yellow: number };

export type CompactEdge = {
  action: Kit;
  probability: number;
  successKey: number;
  failureKey: number;
};

export type CompactNode = {
  key: number;
  sid: number;
  state: CollectionState;
  stock: CompactStockUses;
  stockTotal: number;
  terminal: boolean;
  edges: CompactEdge[];
};

export type CompactStateGraph = {
  rootKey: number;
  initialStockPieces: Stock;
  initialStockUses: CompactStockUses;
  nodes: CompactNode[];
  indexByKey: Map<number, number>;
  edgeCount: number;
  maxLayerWidth: number;
};

export type CompactGraphBuildResult =
  | { outcome: "completed"; graph: CompactStateGraph }
  | {
      outcome: "budget_exceeded";
      reason: "state_budget" | "edge_budget";
      states: number;
      edges: number;
    };

export type CompactMinEfValue = {
  action: Kit | null;
  successProbability: number;
  maxSuccessProbability: number;
  expectedCost: number;
  vector: Stock;
};

export type CompactMinEfResult = {
  root: CompactMinEfValue;
  rootCandidates: Array<CompactMinEfValue & { action: Kit }>;
  values: Map<number, CompactMinEfValue>;
};

export type CompactGraphOptions = {
  stateBudget?: number;
  edgeBudget?: number;
};

export function buildCompactStateGraph(
  start: CollectionState,
  stockPieces: Stock,
  options: CompactGraphOptions = {},
): CompactGraphBuildResult {
  const stateBudget = Math.max(1, Math.trunc(options.stateBudget ?? 1_200_000));
  const edgeBudget = Math.max(1, Math.trunc(options.edgeBudget ?? stateBudget * 6));
  const initialStockUses = stockPiecesToBoundedUses(stockPieces);
  const rootState = canonicalState(normalizeState(start));
  const rootKey = stateStockKey(rootState, initialStockUses);
  const nodes = new Map<number, CompactNode>();
  const queue: number[] = [];
  let cursor = 0;
  let edgeCount = 0;

  const addNode = (state: CollectionState, stock: CompactStockUses): CompactNode | null => {
    const canonical = canonicalState(state);
    const key = stateStockKey(canonical, stock);
    const existing = nodes.get(key);
    if (existing) return existing;
    if (nodes.size >= stateBudget) return null;
    const node: CompactNode = {
      key,
      sid: stateIdNormalized(canonical),
      state: canonical,
      stock: { ...stock },
      stockTotal: stock.blue + stock.purple + stock.yellow,
      terminal: isTerminalNormalized(canonical),
      edges: [],
    };
    nodes.set(key, node);
    queue.push(key);
    return node;
  };

  if (!addNode(rootState, initialStockUses)) {
    return { outcome: "budget_exceeded", reason: "state_budget", states: 0, edges: 0 };
  }

  while (cursor < queue.length) {
    const key = queue[cursor++];
    if (key === undefined) throw new Error("Compact graph queue cursor exceeded its contents.");
    const node = nodes.get(key);
    if (!node) throw new Error(`Missing compact graph node ${key}.`);
    if (node.terminal || node.stockTotal === 0) continue;

    for (const action of KIT_ORDER) {
      if (node.stock[action] <= 0) continue;
      if (edgeCount >= edgeBudget) {
        return {
          outcome: "budget_exceeded",
          reason: "edge_budget",
          states: nodes.size,
          edges: edgeCount,
        };
      }
      const nextStock = decrementUses(node.stock, action);
      const transition = transitionNormalized(node.state, action);
      const successState = canonicalState(transition.success);
      const failureState = canonicalState(transition.fail);
      const success = addNode(successState, nextStock);
      const failure = addNode(failureState, nextStock);
      if (!success || !failure) {
        return {
          outcome: "budget_exceeded",
          reason: "state_budget",
          states: nodes.size,
          edges: edgeCount,
        };
      }
      const expectedRank = node.stockTotal - 1;
      if (success.stockTotal !== expectedRank || failure.stockTotal !== expectedRank) {
        throw new Error(
          "Compact graph transition did not decrease the stock-sum rank exactly once.",
        );
      }
      node.edges.push({
        action,
        probability: transition.probability,
        successKey: success.key,
        failureKey: failure.key,
      });
      edgeCount += 1;
    }
  }

  const ordered = [...nodes.values()].sort(
    (left, right) => left.stockTotal - right.stockTotal || left.key - right.key,
  );
  const widthByLayer = new Map<number, number>();
  for (const node of ordered) {
    widthByLayer.set(node.stockTotal, (widthByLayer.get(node.stockTotal) ?? 0) + 1);
  }
  const graph: CompactStateGraph = {
    rootKey,
    initialStockPieces: { ...stockPieces },
    initialStockUses,
    nodes: ordered,
    indexByKey: new Map(ordered.map((node, index) => [node.key, index])),
    edgeCount,
    maxLayerWidth: Math.max(0, ...widthByLayer.values()),
  };
  assertCompactGraph(graph);
  return { outcome: "completed", graph };
}

export function solveCompactMinEf(
  graph: CompactStateGraph,
  horizonFactor = 0.75,
  normPower = 3,
  tolerance = 0,
): CompactMinEfResult {
  const values = new Map<number, CompactMinEfValue>();
  let rootCandidates: Array<CompactMinEfValue & { action: Kit }> = [];

  for (const node of graph.nodes) {
    if (node.terminal || node.edges.length === 0) {
      values.set(node.key, {
        action: null,
        successProbability: node.terminal ? 1 : 0,
        maxSuccessProbability: node.terminal ? 1 : 0,
        expectedCost: compactLeafCost(graph, node.stock, horizonFactor, normPower),
        vector: { blue: 0, purple: 0, yellow: 0 },
      });
      continue;
    }

    const candidates = node.edges.map((edge) => {
      const success = requiredValue(values, edge.successKey);
      const failure = requiredValue(values, edge.failureKey);
      const inverse = 1 - edge.probability;
      const vector: Stock = {
        blue:
          edge.probability * success.vector.blue +
          inverse * failure.vector.blue +
          (edge.action === "blue" ? 10 : 0),
        purple:
          edge.probability * success.vector.purple +
          inverse * failure.vector.purple +
          (edge.action === "purple" ? 10 : 0),
        yellow:
          edge.probability * success.vector.yellow +
          inverse * failure.vector.yellow +
          (edge.action === "yellow" ? 10 : 0),
      };
      return {
        action: edge.action,
        successProbability:
          edge.probability * success.successProbability + inverse * failure.successProbability,
        actionMaximum:
          edge.probability * success.maxSuccessProbability +
          inverse * failure.maxSuccessProbability,
        expectedCost: edge.probability * success.expectedCost + inverse * failure.expectedCost,
        vector,
      };
    });
    const maxSuccessProbability = Math.max(...candidates.map((item) => item.actionMaximum));
    const eligible = candidates.filter(
      (candidate) =>
        maxSuccessProbability - candidate.successProbability <= tolerance + STRICT_EPSILON,
    );
    const choicePool = eligible.length > 0 ? eligible : candidates;
    let best = choicePool[0];
    if (!best) throw new Error(`Compact graph node ${node.key} has no action candidate.`);
    for (const candidate of choicePool.slice(1)) {
      if (isBetterMinEf(candidate, best)) best = candidate;
    }
    const value: CompactMinEfValue = {
      action: best.action,
      successProbability: best.successProbability,
      maxSuccessProbability,
      expectedCost: best.expectedCost,
      vector: best.vector,
    };
    values.set(node.key, value);
    if (node.key === graph.rootKey) {
      rootCandidates = candidates.map((candidate) => ({
        action: candidate.action,
        successProbability: candidate.successProbability,
        maxSuccessProbability,
        expectedCost: candidate.expectedCost,
        vector: candidate.vector,
      }));
    }
  }

  return { root: requiredValue(values, graph.rootKey), rootCandidates, values };
}

export function assertCompactGraph(graph: CompactStateGraph): void {
  if (!graph.indexByKey.has(graph.rootKey)) throw new Error("Compact graph root is missing.");
  for (const node of graph.nodes) {
    if (isConvertStateNormalized(node.state)) {
      throw new Error("R15 conversion aliases must not be materialized as compact graph nodes.");
    }
    for (const edge of node.edges) {
      const success = graph.nodes[graph.indexByKey.get(edge.successKey) ?? -1];
      const failure = graph.nodes[graph.indexByKey.get(edge.failureKey) ?? -1];
      if (!success || !failure) throw new Error("Compact graph edge targets a missing node.");
      if (
        success.stockTotal !== node.stockTotal - 1 ||
        failure.stockTotal !== node.stockTotal - 1
      ) {
        throw new Error("Compact graph edge violates the stock-sum topological rank.");
      }
    }
  }
}

export function compactTransitionTable(): Uint32Array {
  const table = new Uint32Array(STATE_BUCKETS * 3 * 2);
  for (let sid = 0; sid < STATE_BUCKETS; sid += 1) {
    const state = stateFromId(sid);
    for (const action of KIT_ORDER) {
      const offset = (sid * 3 + KIT_INDEX[action]) * 2;
      if (isTerminalNormalized(state) || isConvertStateNormalized(state)) {
        const canonical = canonicalState(state);
        table[offset] = stateIdNormalized(canonical);
        table[offset + 1] = stateIdNormalized(canonical);
        continue;
      }
      const edge = transitionNormalized(state, action);
      table[offset] = stateIdNormalized(canonicalState(edge.success));
      table[offset + 1] = stateIdNormalized(canonicalState(edge.fail));
    }
  }
  return table;
}

export function expandFrontierKeysCpu(
  inputKeys: readonly number[],
  transitions = compactTransitionTable(),
): number[] {
  const output = new Set<number>();
  for (const key of inputKeys) {
    const { sid, state, stock } = decodeStateStockKey(key);
    if (isTerminalNormalized(state) || stock.blue + stock.purple + stock.yellow === 0) continue;
    for (const action of KIT_ORDER) {
      if (stock[action] <= 0) continue;
      const nextStock = decrementUses(stock, action);
      const offset = (sid * 3 + KIT_INDEX[action]) * 2;
      output.add(stateStockKeyFromSid(transitions[offset] ?? 0, nextStock));
      output.add(stateStockKeyFromSid(transitions[offset + 1] ?? 0, nextStock));
    }
  }
  return [...output].sort((left, right) => left - right);
}

export function stateFromId(sid: number): CollectionState {
  if (!Number.isInteger(sid) || sid < 0 || sid >= STATE_BUCKETS) {
    throw new Error(`State id outside compact graph domain: ${sid}`);
  }
  const gradeId = Math.floor(sid / (LEVEL_BUCKETS * EXP_BUCKETS));
  const level = Math.floor(sid / EXP_BUCKETS) % LEVEL_BUCKETS;
  const exp = (sid % EXP_BUCKETS) * 100;
  return { grade: gradeId === 1 ? "SR" : "R", level, exp };
}

export function decodeStateStockKey(key: number): {
  sid: number;
  state: CollectionState;
  stock: CompactStockUses;
} {
  if (!Number.isSafeInteger(key) || key < 0 || key >= STATE_BUCKETS * STOCK_ID_SIZE) {
    throw new Error(`Compact graph key outside memo domain: ${key}`);
  }
  const sid = Math.floor(key / STOCK_ID_SIZE);
  const stockId = key - sid * STOCK_ID_SIZE;
  const blue = Math.floor(stockId / (PURPLE_DIM * YELLOW_DIM));
  const remainder = stockId - blue * PURPLE_DIM * YELLOW_DIM;
  const purple = Math.floor(remainder / YELLOW_DIM);
  const yellow = remainder - purple * YELLOW_DIM;
  return { sid, state: stateFromId(sid), stock: { blue, purple, yellow } };
}

export function stateStockKey(state: CollectionState, stock: CompactStockUses): number {
  return stateStockKeyFromSid(stateIdNormalized(state), stock);
}

export function stateStockKeyFromSid(sid: number, stock: CompactStockUses): number {
  return sid * STOCK_ID_SIZE + (stock.blue * PURPLE_DIM + stock.purple) * YELLOW_DIM + stock.yellow;
}

export const COMPACT_GRAPH_DIMENSIONS = {
  stateBuckets: STATE_BUCKETS,
  purpleDimension: PURPLE_DIM,
  yellowDimension: YELLOW_DIM,
  stockIdSize: STOCK_ID_SIZE,
} as const;

function stockPiecesToBoundedUses(stock: Stock): CompactStockUses {
  return {
    blue: Math.min(MAX_RELEVANT_USES.blue, Math.max(0, Math.floor(stock.blue / 10))),
    purple: Math.min(MAX_RELEVANT_USES.purple, Math.max(0, Math.floor(stock.purple / 10))),
    yellow: Math.min(MAX_RELEVANT_USES.yellow, Math.max(0, Math.floor(stock.yellow / 10))),
  };
}

function canonicalState(state: CollectionState): CollectionState {
  return isConvertStateNormalized(state) ? convertState() : state;
}

function decrementUses(stock: CompactStockUses, action: Kit): CompactStockUses {
  return {
    blue: stock.blue - (action === "blue" ? 1 : 0),
    purple: stock.purple - (action === "purple" ? 1 : 0),
    yellow: stock.yellow - (action === "yellow" ? 1 : 0),
  };
}

export function compactLeafCost(
  graph: CompactStateGraph,
  remaining: CompactStockUses,
  horizonFactor: number,
  normPower: number,
): number {
  const consumed: Stock = {
    blue: (graph.initialStockUses.blue - remaining.blue) * 10,
    purple: (graph.initialStockUses.purple - remaining.purple) * 10,
    yellow: (graph.initialStockUses.yellow - remaining.yellow) * 10,
  };
  return researchCostScore(consumed, graph.initialStockPieces, {
    kind: "availability-pnorm",
    horizonFactor,
    normPower,
  });
}

function isBetterMinEf(
  candidate: { expectedCost: number; vector: Stock; successProbability: number },
  incumbent: { expectedCost: number; vector: Stock; successProbability: number },
): boolean {
  const costDelta = candidate.expectedCost - incumbent.expectedCost;
  if (Math.abs(costDelta) > STRICT_EPSILON) return costDelta < 0;
  const candidateTotal = candidate.vector.blue + candidate.vector.purple + candidate.vector.yellow;
  const incumbentTotal = incumbent.vector.blue + incumbent.vector.purple + incumbent.vector.yellow;
  const totalDelta = candidateTotal - incumbentTotal;
  if (Math.abs(totalDelta) > STRICT_EPSILON) return totalDelta < 0;
  return candidate.successProbability > incumbent.successProbability;
}

function requiredValue(values: Map<number, CompactMinEfValue>, key: number): CompactMinEfValue {
  const value = values.get(key);
  if (!value) throw new Error(`Compact Bellman order is missing child ${key}.`);
  return value;
}

export function expectedGainAvailability(stock: Stock, horizonFactor: number): Stock {
  return {
    blue: stock.blue + horizonFactor * EXPECTED_28_DAY_GAIN.blue,
    purple: stock.purple + horizonFactor * EXPECTED_28_DAY_GAIN.purple,
    yellow: stock.yellow + horizonFactor * EXPECTED_28_DAY_GAIN.yellow,
  };
}
