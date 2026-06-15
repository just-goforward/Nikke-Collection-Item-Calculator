import type { FunctionMetrics } from "./architecture-types.ts";

const RESERVED_FUNCTION_NAMES = new Set(["if", "for", "while", "switch", "catch"]);
const FUNCTION_NAME_PATTERNS = [
  /\bfunction\s+([A-Za-z0-9_$]+)/,
  /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/,
  /^\s*(?:async\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/,
];

function isCodeLine(line: string) {
  const trimmed = line.trim();
  return trimmed.length > 0 && !trimmed.startsWith("//") && !trimmed.startsWith("*");
}

function functionName(line: string) {
  for (const pattern of FUNCTION_NAME_PATTERNS) {
    const match = line.match(pattern);
    if (match?.[1] && !RESERVED_FUNCTION_NAMES.has(match[1])) return match[1];
  }
  return null;
}

function detectedFunctionName(current: FunctionMetrics | null, line: string) {
  return current === null ? functionName(line) : null;
}

export function measureFunctions(source: string, file = "<memory>"): FunctionMetrics[] {
  const lines = source.split(/\r?\n/);
  const metrics: FunctionMetrics[] = [];
  let current: FunctionMetrics | null = null;
  let braceDepth = 0;
  let functionStartDepth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const detectedName = detectedFunctionName(current, line);
    if (detectedName) {
      const openBraces = (line.match(/\{/g) || []).length;
      const closeBraces = (line.match(/\}/g) || []).length;
      functionStartDepth = braceDepth;
      current = {
        file,
        name: detectedName,
        startLine: index + 1,
        endLine: index + 1,
        lines: 1,
        maxDepth: 0,
        complexity: 1,
      };
      braceDepth += openBraces - closeBraces;
      continue;
    }

    if (!current) {
      braceDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      continue;
    }

    current.endLine = index + 1;
    current.lines += 1;
    if (isCodeLine(line)) {
      const controlCount = (line.match(/\b(if|for|while|case|catch)\b|\?\s*[^?:]/g) || []).length;
      current.complexity += controlCount;
      current.maxDepth = Math.max(current.maxDepth, Math.max(0, braceDepth - functionStartDepth));
    }

    braceDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (braceDepth <= functionStartDepth) {
      metrics.push(current);
      current = null;
    }
  }

  if (current) metrics.push(current);
  return metrics;
}
