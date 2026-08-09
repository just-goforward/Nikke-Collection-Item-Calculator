import { STRICT_EPSILON } from "../src/solver/domain";
import type { Kit, Stock } from "../src/types";
import type { CompactMinEfValue, CompactStateGraph } from "./compact-exact-graph";

export type CompletePolicyOracleResult = {
  root: CompactMinEfValue;
  policy: Map<number, Kit>;
  policiesEvaluated: number;
};

export function enumerateCompletePolicies(
  graph: CompactStateGraph,
  leafCost: (nodeKey: number) => number,
  maxPolicies = 1_000_000,
): CompletePolicyOracleResult {
  const decisionNodes = graph.nodes.filter((node) => node.edges.length > 0);
  const policyCount = decisionNodes.reduce((count, node) => count * node.edges.length, 1);
  if (!Number.isSafeInteger(policyCount) || policyCount > maxPolicies) {
    throw new Error(
      `Complete policy enumeration requires ${policyCount} policies, above ${maxPolicies}.`,
    );
  }

  let best: { root: CompactMinEfValue; policy: Map<number, Kit> } | null = null;
  const selected = new Map<number, Kit>();
  let policiesEvaluated = 0;

  const visitPolicy = (index: number) => {
    if (index < decisionNodes.length) {
      const node = decisionNodes[index];
      if (!node) throw new Error("Missing decision node during policy enumeration.");
      for (const edge of node.edges) {
        selected.set(node.key, edge.action);
        visitPolicy(index + 1);
      }
      selected.delete(node.key);
      return;
    }
    policiesEvaluated += 1;
    const root = evaluatePolicy(graph, selected, leafCost);
    if (!best || policyRootIsBetter(root, best.root)) {
      best = { root, policy: new Map(selected) };
    }
  };

  visitPolicy(0);
  const finalBest = best as { root: CompactMinEfValue; policy: Map<number, Kit> } | null;
  if (!finalBest) throw new Error("Complete policy enumeration produced no policy.");
  return { ...finalBest, policiesEvaluated };
}

function evaluatePolicy(
  graph: CompactStateGraph,
  policy: ReadonlyMap<number, Kit>,
  leafCost: (nodeKey: number) => number,
): CompactMinEfValue {
  const values = new Map<number, CompactMinEfValue>();
  for (const node of graph.nodes) {
    if (node.terminal || node.edges.length === 0) {
      values.set(node.key, {
        action: null,
        successProbability: node.terminal ? 1 : 0,
        maxSuccessProbability: node.terminal ? 1 : 0,
        expectedCost: leafCost(node.key),
        vector: { blue: 0, purple: 0, yellow: 0 },
      });
      continue;
    }
    const action = policy.get(node.key);
    const edge = node.edges.find((candidate) => candidate.action === action);
    if (!edge || !action) throw new Error(`Policy has no valid action for node ${node.key}.`);
    const success = values.get(edge.successKey);
    const failure = values.get(edge.failureKey);
    if (!success || !failure) throw new Error("Policy evaluation violated topological order.");
    const inverse = 1 - edge.probability;
    const vector: Stock = {
      blue:
        edge.probability * success.vector.blue +
        inverse * failure.vector.blue +
        (action === "blue" ? 10 : 0),
      purple:
        edge.probability * success.vector.purple +
        inverse * failure.vector.purple +
        (action === "purple" ? 10 : 0),
      yellow:
        edge.probability * success.vector.yellow +
        inverse * failure.vector.yellow +
        (action === "yellow" ? 10 : 0),
    };
    const successProbability =
      edge.probability * success.successProbability + inverse * failure.successProbability;
    values.set(node.key, {
      action,
      successProbability,
      maxSuccessProbability: successProbability,
      expectedCost: edge.probability * success.expectedCost + inverse * failure.expectedCost,
      vector,
    });
  }
  const root = values.get(graph.rootKey);
  if (!root) throw new Error("Policy evaluation did not produce a root value.");
  return root;
}

function policyRootIsBetter(candidate: CompactMinEfValue, incumbent: CompactMinEfValue): boolean {
  const probabilityDelta = candidate.successProbability - incumbent.successProbability;
  if (Math.abs(probabilityDelta) > STRICT_EPSILON) return probabilityDelta > 0;
  const costDelta = candidate.expectedCost - incumbent.expectedCost;
  if (Math.abs(costDelta) > STRICT_EPSILON) return costDelta < 0;
  return total(candidate.vector) < total(incumbent.vector) - STRICT_EPSILON;
}

function total(vector: Stock): number {
  return vector.blue + vector.purple + vector.yellow;
}
