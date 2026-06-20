import ts from "typescript";

import type { FunctionMetrics } from "./architecture-types.ts";

function scriptKind(file: string) {
  return file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function sourceFileFor(source: string, file: string) {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
}

function isMeasuredFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionName(node: ts.FunctionLikeDeclaration, sourceFile: ts.SourceFile) {
  if (node.name) return node.name.getText(sourceFile);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent)) return parent.name.getText(sourceFile);
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  return "<anonymous>";
}

function isControlNode(node: ts.Node) {
  return (
    ts.isCatchClause(node) ||
    ts.isConditionalExpression(node) ||
    ts.isDoStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isIfStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isWhileStatement(node)
  );
}

function complexityIncrement(node: ts.Node) {
  if (isControlNode(node)) return 1;
  if (ts.isCaseClause(node)) return 1;
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(node.operatorToken.kind)
  ) {
    return 1;
  }
  return 0;
}

function controlFlowMetrics(root: ts.FunctionLikeDeclaration) {
  let complexity = 1;
  let maxDepth = 0;

  function visit(node: ts.Node, depth: number) {
    if (node !== root && isMeasuredFunction(node)) return;
    const control = isControlNode(node);
    const nextDepth = control ? depth + 1 : depth;
    if (control) maxDepth = Math.max(maxDepth, nextDepth);
    complexity += complexityIncrement(node);
    ts.forEachChild(node, (child) => visit(child, nextDepth));
  }

  if (root.body) visit(root.body, 0);
  return { complexity, maxDepth };
}

export function measureFunctions(source: string, file = "<memory>"): FunctionMetrics[] {
  const sourceFile = sourceFileFor(source, file);
  const metrics: FunctionMetrics[] = [];

  function visit(node: ts.Node) {
    if (isMeasuredFunction(node) && node.body) {
      const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      metrics.push({
        file,
        name: functionName(node, sourceFile),
        startLine,
        endLine,
        lines: endLine - startLine + 1,
        ...controlFlowMetrics(node),
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return metrics;
}
