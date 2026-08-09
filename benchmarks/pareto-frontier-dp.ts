import { STRICT_EPSILON } from "../src/solver/domain";
import type { Kit, Stock } from "../src/types";
import type { CompactEdge, CompactStateGraph } from "./compact-exact-graph";

export type ParetoPoint = {
  action: Kit | null;
  successProbability: number;
  vector: Stock;
};

export type ParetoFrontierResult =
  | {
      outcome: "completed";
      root: ParetoPoint[];
      totalVectors: number;
      p50Width: number;
      p95Width: number;
      maximumWidth: number;
      frontiers: Map<number, ParetoPoint[]>;
    }
  | {
      outcome: "vector_budget_exceeded";
      totalVectors: number;
      maximumWidth: number;
    };

export function solveParetoFrontiers(
  graph: CompactStateGraph,
  vectorBudget = 2_000_000,
): ParetoFrontierResult {
  const frontiers = new Map<number, ParetoPoint[]>();
  const widths: number[] = [];
  let totalVectors = 0;
  let maximumWidth = 0;
  for (const node of graph.nodes) {
    let frontier: ParetoPoint[];
    if (node.terminal || node.edges.length === 0) {
      frontier = [
        {
          action: null,
          successProbability: node.terminal ? 1 : 0,
          vector: { blue: 0, purple: 0, yellow: 0 },
        },
      ];
    } else {
      const candidates: ParetoPoint[] = [];
      for (const edge of node.edges) {
        const success = frontiers.get(edge.successKey);
        const failure = frontiers.get(edge.failureKey);
        if (!success || !failure) throw new Error("Pareto DP violated compact topological order.");
        if (
          !appendEdgeCandidates(candidates, edge, success, failure, vectorBudget - totalVectors)
        ) {
          return { outcome: "vector_budget_exceeded", totalVectors, maximumWidth };
        }
      }
      frontier = paretoPrune(candidates);
    }
    frontiers.set(node.key, frontier);
    widths.push(frontier.length);
    totalVectors += frontier.length;
    maximumWidth = Math.max(maximumWidth, frontier.length);
    if (totalVectors > vectorBudget) {
      return { outcome: "vector_budget_exceeded", totalVectors, maximumWidth };
    }
  }
  const root = frontiers.get(graph.rootKey);
  if (!root) throw new Error("Pareto DP produced no root frontier.");
  return {
    outcome: "completed",
    root,
    totalVectors,
    p50Width: percentile(widths, 0.5),
    p95Width: percentile(widths, 0.95),
    maximumWidth,
    frontiers,
  };
}

function appendEdgeCandidates(
  target: ParetoPoint[],
  edge: CompactEdge,
  successPoints: readonly ParetoPoint[],
  failurePoints: readonly ParetoPoint[],
  maximumCandidates: number,
): boolean {
  const inverse = 1 - edge.probability;
  for (const successPoint of successPoints) {
    for (const failurePoint of failurePoints) {
      if (target.length >= maximumCandidates) return false;
      target.push({
        action: edge.action,
        successProbability:
          edge.probability * successPoint.successProbability +
          inverse * failurePoint.successProbability,
        vector: {
          blue:
            edge.probability * successPoint.vector.blue +
            inverse * failurePoint.vector.blue +
            (edge.action === "blue" ? 10 : 0),
          purple:
            edge.probability * successPoint.vector.purple +
            inverse * failurePoint.vector.purple +
            (edge.action === "purple" ? 10 : 0),
          yellow:
            edge.probability * successPoint.vector.yellow +
            inverse * failurePoint.vector.yellow +
            (edge.action === "yellow" ? 10 : 0),
        },
      });
    }
  }
  return true;
}

export function paretoPrune(points: readonly ParetoPoint[]): ParetoPoint[] {
  const unique: ParetoPoint[] = [];
  for (const point of points) {
    if (unique.some((existing) => equivalent(existing, point))) continue;
    if (unique.some((existing) => dominates(existing, point))) continue;
    for (let index = unique.length - 1; index >= 0; index -= 1) {
      const existing = unique[index];
      if (existing && dominates(point, existing)) unique.splice(index, 1);
    }
    unique.push(point);
  }
  return unique.sort(
    (left, right) =>
      right.successProbability - left.successProbability ||
      total(left.vector) - total(right.vector) ||
      String(left.action).localeCompare(String(right.action)),
  );
}

function dominates(left: ParetoPoint, right: ParetoPoint): boolean {
  const nonWorse =
    left.successProbability >= right.successProbability - STRICT_EPSILON &&
    left.vector.blue <= right.vector.blue + STRICT_EPSILON &&
    left.vector.purple <= right.vector.purple + STRICT_EPSILON &&
    left.vector.yellow <= right.vector.yellow + STRICT_EPSILON;
  const strict =
    left.successProbability > right.successProbability + STRICT_EPSILON ||
    left.vector.blue < right.vector.blue - STRICT_EPSILON ||
    left.vector.purple < right.vector.purple - STRICT_EPSILON ||
    left.vector.yellow < right.vector.yellow - STRICT_EPSILON;
  return nonWorse && strict;
}

function equivalent(left: ParetoPoint, right: ParetoPoint): boolean {
  return (
    Math.abs(left.successProbability - right.successProbability) <= STRICT_EPSILON &&
    Math.abs(left.vector.blue - right.vector.blue) <= STRICT_EPSILON &&
    Math.abs(left.vector.purple - right.vector.purple) <= STRICT_EPSILON &&
    Math.abs(left.vector.yellow - right.vector.yellow) <= STRICT_EPSILON
  );
}

function total(vector: Stock): number {
  return vector.blue + vector.purple + vector.yellow;
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0
  );
}
