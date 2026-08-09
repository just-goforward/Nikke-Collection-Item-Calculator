import { createHash } from "node:crypto";

import type { CompactMinEfResult, CompactStateGraph } from "./compact-exact-graph";

export type SymbolicCompressionScreen = {
  nodes: number;
  uniquePartitions: number;
  reduction: number;
  exactValueMismatches: number;
};

export function screenExactSymbolicCompression(
  graph: CompactStateGraph,
  solution: CompactMinEfResult,
): SymbolicCompressionScreen {
  const partitionByKey = new Map<number, string>();
  const valueByPartition = new Map<string, string>();
  let exactValueMismatches = 0;
  for (const node of graph.nodes) {
    const value = solution.values.get(node.key);
    if (!value) throw new Error(`Symbolic screen is missing compact value ${node.key}.`);
    const edgeSignature = node.edges.map((edge) => ({
      action: edge.action,
      probability: f64Hex(edge.probability),
      success: partitionByKey.get(edge.successKey),
      failure: partitionByKey.get(edge.failureKey),
    }));
    const partition = digest({
      sid: node.sid,
      terminal: node.terminal,
      edges: edgeSignature,
      value: valueSignature(value),
    });
    const valueSignatureText = valueSignature(value);
    const existing = valueByPartition.get(partition);
    if (existing !== undefined && existing !== valueSignatureText) exactValueMismatches += 1;
    valueByPartition.set(partition, valueSignatureText);
    partitionByKey.set(node.key, partition);
  }
  return {
    nodes: graph.nodes.length,
    uniquePartitions: valueByPartition.size,
    reduction: graph.nodes.length === 0 ? 0 : 1 - valueByPartition.size / graph.nodes.length,
    exactValueMismatches,
  };
}

function valueSignature(value: CompactMinEfResult["root"]): string {
  return [
    value.action ?? "none",
    f64Hex(value.successProbability),
    f64Hex(value.maxSuccessProbability),
    f64Hex(value.expectedCost),
    f64Hex(value.vector.blue),
    f64Hex(value.vector.purple),
    f64Hex(value.vector.yellow),
  ].join(":");
}

function f64Hex(value: number): string {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false).toString(16).padStart(16, "0");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
