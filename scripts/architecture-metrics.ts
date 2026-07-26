import { type Program, parseSync } from "oxc-parser";

import type { FunctionMetrics } from "./architecture-types.ts";

type AstNode = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "MethodDefinition",
  "TSDeclareMethod",
]);

const CONTROL_TYPES = new Set([
  "CatchClause",
  "ConditionalExpression",
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "IfStatement",
  "SwitchStatement",
  "WhileStatement",
]);

const LOGICAL_OPERATORS = new Set(["&&", "||", "??"]);

function parseProgram(source: string, file: string) {
  const result = parseSync(file, source, {
    astType: "ts",
    lang: file.endsWith(".tsx") ? "tsx" : "ts",
    sourceType: "module",
  });
  if (result.errors.length > 0) {
    throw new Error(`Failed to parse ${file}: ${result.errors[0]?.message ?? "unknown error"}`);
  }
  return result.program;
}

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { start?: unknown }).start === "number" &&
    typeof (value as { end?: unknown }).end === "number"
  );
}

function childNodes(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (isAstNode(value)) {
      children.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) children.push(item);
      }
    }
  }
  return children;
}

function lineStarts(source: string) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineForPosition(starts: number[], position: number) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = starts[middle] ?? 0;
    const next = starts[middle + 1] ?? Number.POSITIVE_INFINITY;
    if (position < start) high = middle - 1;
    else if (position >= next) low = middle + 1;
    else return middle + 1;
  }
  return starts.length;
}

function isMeasuredFunction(node: AstNode) {
  return FUNCTION_TYPES.has(node.type);
}

function identifierName(value: unknown) {
  if (isAstNode(value) && value.type === "Identifier") {
    const name = value["name"];
    return typeof name === "string" ? name : null;
  }
  return null;
}

function propertyName(value: unknown) {
  if (!isAstNode(value)) return null;
  if (value.type === "Identifier" || value.type === "PrivateIdentifier") {
    const name = value["name"];
    return typeof name === "string" ? name : null;
  }
  if (value.type === "Literal") {
    const raw = value["raw"];
    const literal = value["value"];
    if (typeof literal === "string") return literal;
    return typeof raw === "string" ? raw : null;
  }
  return null;
}

function functionName(node: AstNode, parent: AstNode | null) {
  const directName = identifierName(node["id"]) ?? propertyName(node["key"]);
  if (directName) return directName;
  if (parent?.type === "VariableDeclarator") {
    return identifierName(parent["id"]) ?? "<anonymous>";
  }
  if (parent?.type === "Property" || parent?.type === "PropertyDefinition") {
    return propertyName(parent["key"]) ?? "<anonymous>";
  }
  if (node["kind"] === "constructor") return "constructor";
  return "<anonymous>";
}

function isControlNode(node: AstNode) {
  return CONTROL_TYPES.has(node.type);
}

function complexityIncrement(node: AstNode) {
  if (isControlNode(node)) return 1;
  if (node.type === "SwitchCase") return 1;
  if (node.type === "LogicalExpression" && LOGICAL_OPERATORS.has(String(node["operator"]))) {
    return 1;
  }
  return 0;
}

function controlFlowMetrics(root: AstNode) {
  let complexity = 1;
  let maxDepth = 0;

  function visit(node: AstNode, depth: number) {
    if (node !== root && isMeasuredFunction(node)) return;
    const control = isControlNode(node);
    const nextDepth = control ? depth + 1 : depth;
    if (control) maxDepth = Math.max(maxDepth, nextDepth);
    complexity += complexityIncrement(node);
    for (const child of childNodes(node)) visit(child, nextDepth);
  }

  const body = isAstNode(root["body"]) ? root["body"] : root;
  visit(body, 0);
  return { complexity, maxDepth };
}

function walkFunctions(root: Program, visitor: (node: AstNode, parent: AstNode | null) => void) {
  if (!isAstNode(root)) throw new Error("Oxc parser returned a non-node Program.");
  function visit(node: AstNode, parent: AstNode | null) {
    if (isMeasuredFunction(node)) visitor(node, parent);
    for (const child of childNodes(node)) visit(child, node);
  }
  visit(root, null);
}

export function measureFunctions(source: string, file = "<memory>"): FunctionMetrics[] {
  const program = parseProgram(source, file);
  const starts = lineStarts(source);
  const metrics: FunctionMetrics[] = [];

  walkFunctions(program, (node, parent) => {
    const startLine = lineForPosition(starts, node.start);
    const endLine = lineForPosition(starts, node.end);
    metrics.push({
      file,
      name: functionName(node, parent),
      startLine,
      endLine,
      lines: endLine - startLine + 1,
      ...controlFlowMetrics(node),
    });
  });

  return metrics;
}
