import type { CompactStateGraph } from "./compact-exact-graph";

export type CompactReachabilityMps = {
  text: string;
  variables: number;
  flowRows: number;
};

export function exportMaximumReachabilityMps(
  graph: CompactStateGraph,
  modelName = "COMPACT_REACH",
): CompactReachabilityMps {
  const decisions = graph.nodes.filter((node) => node.edges.length > 0);
  const decisionIndex = new Map(decisions.map((node, index) => [node.key, index]));
  const lines = ["OBJSENSE", " MAX", `NAME          ${sanitizeName(modelName)}`, "ROWS", " N  OBJ"];
  for (const [index] of decisions.entries()) lines.push(` E  F${index}`);
  lines.push("COLUMNS");

  let variables = 0;
  for (const [nodeIndex, node] of decisions.entries()) {
    for (const [actionIndex, edge] of node.edges.entries()) {
      const variable = `X${nodeIndex}_${actionIndex}`;
      const success = graph.nodes[graph.indexByKey.get(edge.successKey) ?? -1];
      const failure = graph.nodes[graph.indexByKey.get(edge.failureKey) ?? -1];
      if (!success || !failure) throw new Error("LP export found a missing compact edge target.");
      const objective =
        (success.terminal ? edge.probability : 0) + (failure.terminal ? 1 - edge.probability : 0);
      appendCoefficient(lines, variable, "OBJ", objective);
      appendCoefficient(lines, variable, `F${nodeIndex}`, 1);
      const successRow = decisionIndex.get(success.key);
      if (successRow !== undefined) {
        appendCoefficient(lines, variable, `F${successRow}`, -edge.probability);
      }
      const failureRow = decisionIndex.get(failure.key);
      if (failureRow !== undefined) {
        appendCoefficient(lines, variable, `F${failureRow}`, -(1 - edge.probability));
      }
      variables += 1;
    }
  }

  lines.push("RHS");
  const rootRow = decisionIndex.get(graph.rootKey);
  if (rootRow !== undefined) lines.push(`    RHS1      F${rootRow}      1`);
  lines.push("BOUNDS");
  for (const [nodeIndex, node] of decisions.entries()) {
    for (const [actionIndex] of node.edges.entries()) {
      lines.push(` LO BND1      X${nodeIndex}_${actionIndex}      0`);
    }
  }
  lines.push("ENDATA");
  return { text: `${lines.join("\n")}\n`, variables, flowRows: decisions.length };
}

function appendCoefficient(lines: string[], variable: string, row: string, value: number): void {
  if (value === 0) return;
  if (!Number.isFinite(value)) throw new Error("LP coefficient must be finite.");
  lines.push(`    ${variable.padEnd(10)}${row.padEnd(10)}${formatNumber(value)}`);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toPrecision(17);
}

function sanitizeName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/gu, "_").slice(0, 32);
  return sanitized || "COMPACT_REACH";
}
