import type { Kit } from "../src/types";
import {
  type CompactStateGraph,
  type CompactStockUses,
  compactLeafCost,
} from "./compact-exact-graph";

export type CompactLpObjective =
  | "maximum_reachability"
  | "minimum_expected_cost"
  | "minimum_expected_uses";

export type CompactLpVariable = {
  name: string;
  stateKey: number;
  action: Kit;
  reachabilityCoefficient: number;
  expectedCostCoefficient: number;
  expectedUsesCoefficient: number;
};

export type CompactOccupancyMps = {
  text: string;
  objective: CompactLpObjective;
  variables: CompactLpVariable[];
  flowRows: number;
};

export type CompactLpOptions = {
  horizonFactor?: number;
  normPower?: number;
  minimumReachability?: number;
  maximumExpectedCost?: number;
};

export type ParsedHighsSolution = {
  modelStatus: string;
  primalStatus: string;
  objective: number;
  columns: Map<string, number>;
};

type CompactDecisionNode = CompactStateGraph["nodes"][number];

export function exportMaximumReachabilityMps(
  graph: CompactStateGraph,
  modelName = "COMPACT_REACH",
): CompactOccupancyMps {
  return exportCompactOccupancyMps(graph, "maximum_reachability", {}, modelName);
}

export function exportCompactOccupancyMps(
  graph: CompactStateGraph,
  objective: CompactLpObjective,
  options: CompactLpOptions = {},
  modelName = "COMPACT_POLICY",
): CompactOccupancyMps {
  const horizonFactor = options.horizonFactor ?? 0.75;
  const normPower = options.normPower ?? 3;
  const decisions = graph.nodes.filter((node) => node.edges.length > 0);
  const decisionIndex = new Map(decisions.map((node, index) => [node.key, index]));
  const variables = buildVariables(graph, decisions, horizonFactor, normPower);

  const lines = [
    "OBJSENSE",
    objective === "maximum_reachability" ? " MAX" : " MIN",
    `NAME          ${sanitizeName(modelName)}`,
    "ROWS",
    " N  OBJ",
  ];
  appendConstraintRows(lines, decisions.length, options);
  lines.push("COLUMNS");
  appendVariableColumns(lines, decisions, decisionIndex, variables, objective, options);
  lines.push("RHS");
  appendRightHandSide(lines, decisionIndex.get(graph.rootKey), options);
  lines.push("BOUNDS");
  for (const variable of variables) lines.push(` LO BND1      ${variable.name}      0`);
  lines.push("ENDATA");
  return { text: `${lines.join("\n")}\n`, objective, variables, flowRows: decisions.length };
}

function buildVariables(
  graph: CompactStateGraph,
  decisions: readonly CompactDecisionNode[],
  horizonFactor: number,
  normPower: number,
): CompactLpVariable[] {
  const variables: CompactLpVariable[] = [];
  for (const [nodeIndex, node] of decisions.entries()) {
    for (const [actionIndex, edge] of node.edges.entries()) {
      const success = graph.nodes[graph.indexByKey.get(edge.successKey) ?? -1];
      const failure = graph.nodes[graph.indexByKey.get(edge.failureKey) ?? -1];
      if (!success || !failure) throw new Error("LP export found a missing compact edge target.");
      const inverse = 1 - edge.probability;
      variables.push({
        name: `X${nodeIndex}_${actionIndex}`,
        stateKey: node.key,
        action: edge.action,
        reachabilityCoefficient:
          (success.terminal ? edge.probability : 0) + (failure.terminal ? inverse : 0),
        expectedCostCoefficient:
          leafContribution(
            graph,
            success.stock,
            success.terminal || success.edges.length === 0,
            edge.probability,
            horizonFactor,
            normPower,
          ) +
          leafContribution(
            graph,
            failure.stock,
            failure.terminal || failure.edges.length === 0,
            inverse,
            horizonFactor,
            normPower,
          ),
        expectedUsesCoefficient: 10,
      });
    }
  }
  return variables;
}

function appendConstraintRows(
  lines: string[],
  decisionCount: number,
  options: CompactLpOptions,
): void {
  for (let index = 0; index < decisionCount; index += 1) lines.push(` E  F${index}`);
  if (options.minimumReachability !== undefined) lines.push(" G  REACH");
  if (options.maximumExpectedCost !== undefined) lines.push(" L  COSTCAP");
}

function appendVariableColumns(
  lines: string[],
  decisions: readonly CompactDecisionNode[],
  decisionIndex: ReadonlyMap<number, number>,
  variables: readonly CompactLpVariable[],
  objective: CompactLpObjective,
  options: CompactLpOptions,
): void {
  let variableCursor = 0;
  for (const [nodeIndex, node] of decisions.entries()) {
    for (const edge of node.edges) {
      const variable = variables[variableCursor];
      if (!variable) throw new Error("LP variable metadata is incomplete.");
      appendCoefficient(lines, variable.name, "OBJ", objectiveCoefficient(variable, objective));
      appendFlowCoefficients(lines, variable.name, nodeIndex, edge, decisionIndex);
      if (options.minimumReachability !== undefined) {
        appendCoefficient(lines, variable.name, "REACH", variable.reachabilityCoefficient);
      }
      if (options.maximumExpectedCost !== undefined) {
        appendCoefficient(lines, variable.name, "COSTCAP", variable.expectedCostCoefficient);
      }
      variableCursor += 1;
    }
  }
}

function appendFlowCoefficients(
  lines: string[],
  variableName: string,
  nodeIndex: number,
  edge: CompactDecisionNode["edges"][number],
  decisionIndex: ReadonlyMap<number, number>,
): void {
  const coefficients = new Map<string, number>([[`F${nodeIndex}`, 1]]);
  const successRow = decisionIndex.get(edge.successKey);
  if (successRow !== undefined) addCoefficient(coefficients, `F${successRow}`, -edge.probability);
  const failureRow = decisionIndex.get(edge.failureKey);
  if (failureRow !== undefined) {
    addCoefficient(coefficients, `F${failureRow}`, -(1 - edge.probability));
  }
  for (const [row, coefficient] of coefficients) {
    appendCoefficient(lines, variableName, row, coefficient);
  }
}

function appendRightHandSide(
  lines: string[],
  rootRow: number | undefined,
  options: CompactLpOptions,
): void {
  if (rootRow !== undefined) lines.push(`    RHS1      F${rootRow}      1`);
  if (options.minimumReachability !== undefined) {
    lines.push(`    RHS1      REACH     ${formatNumber(options.minimumReachability)}`);
  }
  if (options.maximumExpectedCost !== undefined) {
    lines.push(`    RHS1      COSTCAP   ${formatNumber(options.maximumExpectedCost)}`);
  }
}

export function parseHighsSolution(text: string): ParsedHighsSolution {
  const lines = text.split(/\r?\n/u);
  const modelStatusIndex = lines.findIndex((line) => line.trim() === "Model status");
  const modelStatus = nextNonEmptyLine(lines, modelStatusIndex + 1);
  const primalMarker = lines.findIndex((line) => line.trim() === "# Primal solution values");
  const primalStatus = nextNonEmptyLine(lines, primalMarker + 1);
  const objectiveLine = lines.find((line) => line.trimStart().startsWith("Objective "));
  const objective = objectiveLine ? Number(objectiveLine.trim().slice("Objective ".length)) : NaN;
  const columnsMarker = lines.findIndex((line) => line.trimStart().startsWith("# Columns "));
  const rowsMarker = lines.findIndex(
    (line, index) => index > columnsMarker && line.trimStart().startsWith("# Rows "),
  );
  if (
    !modelStatus ||
    !primalStatus ||
    !Number.isFinite(objective) ||
    columnsMarker < 0 ||
    rowsMarker < 0
  ) {
    throw new Error("HiGHS solution is missing required status, objective, or column data.");
  }
  const columns = new Map<string, number>();
  for (const line of lines.slice(columnsMarker + 1, rowsMarker)) {
    const match = /^\s*(\S+)\s+([-+0-9.eE]+)\s*$/u.exec(line);
    if (!match) continue;
    const [, name, encodedValue] = match;
    if (!name || !encodedValue) continue;
    const value = Number(encodedValue);
    if (!Number.isFinite(value)) throw new Error(`HiGHS column ${name} is not finite.`);
    columns.set(name, value);
  }
  return { modelStatus, primalStatus, objective, columns };
}

export function rootActionFromSolution(
  graph: CompactStateGraph,
  model: CompactOccupancyMps,
  solution: ParsedHighsSolution,
): Kit | null {
  let best: { action: Kit; value: number } | null = null;
  for (const variable of model.variables) {
    if (variable.stateKey !== graph.rootKey) continue;
    const value = solution.columns.get(variable.name) ?? 0;
    if (!best || value > best.value) best = { action: variable.action, value };
  }
  return best && best.value > 0 ? best.action : null;
}

function leafContribution(
  graph: CompactStateGraph,
  stock: CompactStockUses,
  isLeaf: boolean,
  probability: number,
  horizonFactor: number,
  normPower: number,
): number {
  return isLeaf ? probability * compactLeafCost(graph, stock, horizonFactor, normPower) : 0;
}

function objectiveCoefficient(variable: CompactLpVariable, objective: CompactLpObjective): number {
  if (objective === "maximum_reachability") return variable.reachabilityCoefficient;
  if (objective === "minimum_expected_cost") return variable.expectedCostCoefficient;
  return variable.expectedUsesCoefficient;
}

function appendCoefficient(lines: string[], variable: string, row: string, value: number): void {
  if (value === 0) return;
  if (!Number.isFinite(value)) throw new Error("LP coefficient must be finite.");
  lines.push(`    ${variable.padEnd(10)}${row.padEnd(10)}${formatNumber(value)}`);
}

function addCoefficient(coefficients: Map<string, number>, row: string, value: number): void {
  coefficients.set(row, (coefficients.get(row) ?? 0) + value);
}

function nextNonEmptyLine(lines: string[], start: number): string {
  if (start <= 0) return "";
  for (let index = start; index < lines.length; index += 1) {
    const value = lines[index]?.trim();
    if (value) return value;
  }
  return "";
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toPrecision(17);
}

function sanitizeName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/gu, "_").slice(0, 32);
  return sanitized || "COMPACT_POLICY";
}
