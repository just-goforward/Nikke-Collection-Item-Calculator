import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import {
  BIOME_IGNORE_ALLOWLIST,
  CHECK_ROOTS as DEFAULT_CHECK_ROOTS,
  COMPLEXITY_ALLOWLIST,
  DEFAULT_MAX_FILE_LINES,
  EMPTY_CATCH_ALLOWLIST,
  LONG_FILE_ALLOWLIST,
  TYPE_ESCAPE_BOUNDARY_ALLOWLIST,
  debtFiles,
  limitsFor,
} from "./architecture-config.ts";
import { measureFunctions as measureSourceFunctions } from "./architecture-metrics.ts";
import {
  gitTrackedFiles as collectGitTrackedFiles,
  lineCount,
  normalizeFile,
  resolveImport,
  sourceOf,
} from "./architecture-sources.ts";
import type { ArchitectureIssue, DebtEntry, FunctionMetrics } from "./architecture-types.ts";

export const CHECK_ROOTS = DEFAULT_CHECK_ROOTS;

export function gitTrackedFiles(roots?: string[]) {
  return collectGitTrackedFiles(roots);
}

export function measureFunctions(source: string, file = "<memory>"): FunctionMetrics[] {
  return measureSourceFunctions(source, file);
}

function packageScriptEntries(files: Set<string>) {
  const entries = new Set<string>();
  if (!existsSync("package.json")) return entries;

  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scriptPathPattern = /(?:^|\s)([./A-Za-z0-9_-]+\.tsx?)(?=\s|$)/g;

  for (const command of Object.values(packageJson.scripts ?? {})) {
    for (const match of command.matchAll(scriptPathPattern)) {
      const scriptPath = match[1] ? normalizeFile(match[1]) : "";
      if (files.has(scriptPath)) entries.add(scriptPath);
    }
  }

  return entries;
}

function reachabilityEntries(files: string[]) {
  const fileSet = new Set(files);
  const entries = new Set<string>([
    ...packageScriptEntries(fileSet),
    "src/main.tsx",
    "src/worker.ts",
    "cloudflare/src/worker.ts",
  ]);

  for (const file of files) {
    if (file.endsWith(".test.ts") || file.endsWith(".spec.ts")) entries.add(file);
    if (file.startsWith("e2e/") && (file.endsWith(".ts") || file.endsWith(".tsx"))) {
      entries.add(file);
    }
  }

  return [...entries].filter((file) => fileSet.has(file));
}

function reachableFromEntries(graph: Map<string, Set<string>>, entries: string[]) {
  const reachable = new Set<string>();
  const stack = [...entries];

  while (stack.length > 0) {
    const file = stack.pop();
    if (!file || reachable.has(file)) continue;
    reachable.add(file);
    for (const dependency of graph.get(file) ?? []) stack.push(dependency);
  }

  return reachable;
}

function findUnreachableSources(files: string[]) {
  const sourceFiles = files.filter(
    (file) => (file.endsWith(".ts") || file.endsWith(".tsx")) && !file.endsWith(".d.ts"),
  );
  const graph = importGraph(sourceFiles);
  const reachable = reachableFromEntries(graph, reachabilityEntries(sourceFiles));
  return sourceFiles.filter((file) => !reachable.has(file));
}

function importGraph(files: string[]) {
  const fileSet = new Set(files);
  const graph = new Map(files.map((file) => [file, new Set<string>()]));
  for (const file of files.filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
    const source = sourceOf(file);
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const resolved = resolveImport(file, imported.fileName, fileSet);
      if (resolved) graph.get(file)?.add(resolved);
    }
  }

  return graph;
}

function findCycles(graph: Map<string, Set<string>>) {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];

  function visit(file: string) {
    seen.add(file);
    active.add(file);
    stack.push(file);

    for (const dependency of graph.get(file) ?? []) {
      if (!seen.has(dependency)) {
        visit(dependency);
      } else if (active.has(dependency)) {
        const start = stack.indexOf(dependency);
        cycles.push([...stack.slice(start), dependency]);
      }
    }

    stack.pop();
    active.delete(file);
  }

  for (const file of graph.keys()) {
    if (!seen.has(file)) visit(file);
  }

  return cycles;
}

function findReExports(files: string[]) {
  return files
    .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
    .filter((file) => {
      const sourceFile = ts.createSourceFile(
        file,
        sourceOf(file),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      return sourceFile.statements.some(
        (statement) => ts.isExportDeclaration(statement) && Boolean(statement.moduleSpecifier),
      );
    });
}

export function violatesModuleBoundary(file: string, dependency: string) {
  const appViolation =
    file.startsWith("src/") &&
    (dependency.startsWith("cloudflare/") ||
      dependency.startsWith("benchmarks/") ||
      dependency.startsWith("scripts/") ||
      dependency.startsWith("e2e/"));
  const workerViolation =
    file.startsWith("cloudflare/src/") && !dependency.startsWith("cloudflare/src/");
  return appViolation || workerViolation;
}

function findBoundaryViolations(graph: Map<string, Set<string>>) {
  const violations: Array<{ file: string; dependency: string }> = [];
  for (const [file, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (violatesModuleBoundary(file, dependency)) violations.push({ file, dependency });
    }
  }
  return violations;
}

function findUnsafeTypeEscapes(files: string[]) {
  const typeAllowlist = debtFiles(TYPE_ESCAPE_BOUNDARY_ALLOWLIST);
  const doubleCastPattern = String.raw`\bas\s+unknown\s+as\b`;
  const tsIgnorePattern = `@ts-${"ignore"}`;
  const tsExpectErrorPattern = `@ts-${"expect-error"}`;
  const unsafeTypePattern = new RegExp(
    [String.raw`\bas\s+any\b`, doubleCastPattern, tsIgnorePattern, tsExpectErrorPattern].join(
      "|",
    ),
  );
  return files
    .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
    .filter((file) => !typeAllowlist.has(file))
    .filter((file) => unsafeTypePattern.test(sourceOf(file)));
}

function findUnapprovedBiomeIgnores(files: string[]) {
  const biomeAllowlist = debtFiles(BIOME_IGNORE_ALLOWLIST);
  return files
    .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
    .filter((file) => !biomeAllowlist.has(file))
    .filter((file) => sourceOf(file).includes("biome-ignore"));
}

function findEmptyCatches(files: string[]) {
  const emptyCatchAllowlist = debtFiles(EMPTY_CATCH_ALLOWLIST);
  const emptyCatchPattern = /catch\s*\{\s*(?:(?:\/\/|\/\*)[\s\S]*?)?\s*\}/m;
  return files
    .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
    .filter((file) => !emptyCatchAllowlist.has(file))
    .filter((file) => emptyCatchPattern.test(sourceOf(file)));
}

function findFunctionMetricIssues(files: string[]) {
  const complexityAllowlist = debtFiles(COMPLEXITY_ALLOWLIST);
  const issues: ArchitectureIssue[] = [];
  for (const file of files.filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
    if (complexityAllowlist.has(file)) continue;
    const limits = limitsFor(file);
    for (const metric of measureFunctions(sourceOf(file), file)) {
      if (metric.lines > limits.maxFunctionLines) {
        issues.push({
          code: "function-lines",
          file,
          message: `${file}:${metric.startLine} ${metric.name} has ${metric.lines} lines (limit ${limits.maxFunctionLines})`,
        });
      }
      if (metric.maxDepth > limits.maxDepth) {
        issues.push({
          code: "function-depth",
          file,
          message: `${file}:${metric.startLine} ${metric.name} has depth ${metric.maxDepth} (limit ${limits.maxDepth})`,
        });
      }
      if (metric.complexity > limits.maxComplexity) {
        issues.push({
          code: "function-complexity",
          file,
          message: `${file}:${metric.startLine} ${metric.name} has complexity ${metric.complexity} (limit ${limits.maxComplexity})`,
        });
      }
    }
  }
  return issues;
}

function missingAllowlistEntries(files: string[], entries: DebtEntry[], label: string) {
  return entries
    .filter((entry) => !files.includes(entry.file) && !existsSync(entry.file))
    .map((entry) => ({
      code: "missing-allowlist-entry" as const,
      file: entry.file,
      message: `${entry.file} is in ${label} allowlist but is not tracked`,
    }));
}

export function architectureIssues(files: string[]) {
  const longFileAllowlist = debtFiles(LONG_FILE_ALLOWLIST);
  const oversizedFiles = files
    .map((file) => ({ file, lines: lineCount(file) }))
    .filter(({ file, lines }) => lines > DEFAULT_MAX_FILE_LINES && !longFileAllowlist.has(file));
  const graph = importGraph(files);
  const cycles = findCycles(graph);

  const issues: ArchitectureIssue[] = [
    ...oversizedFiles.map(({ file, lines }) => ({
      code: "oversized-file" as const,
      file,
      message: `${file} has ${lines} lines (limit ${DEFAULT_MAX_FILE_LINES})`,
    })),
    ...missingAllowlistEntries(files, LONG_FILE_ALLOWLIST, "long-file"),
    ...missingAllowlistEntries(files, TYPE_ESCAPE_BOUNDARY_ALLOWLIST, "type-escape"),
    ...missingAllowlistEntries(files, BIOME_IGNORE_ALLOWLIST, "biome-ignore"),
    ...missingAllowlistEntries(files, EMPTY_CATCH_ALLOWLIST, "empty-catch"),
    ...missingAllowlistEntries(files, COMPLEXITY_ALLOWLIST, "complexity"),
    ...cycles.map((cycle) => ({
      code: "cycle" as const,
      message: `cycle: ${cycle.join(" -> ")}`,
    })),
    ...findBoundaryViolations(graph).map(({ file, dependency }) => ({
      code: "boundary-violation" as const,
      file,
      message: `module boundary violation: ${file} -> ${dependency}`,
    })),
    ...findReExports(files).map((file) => ({
      code: "re-export" as const,
      file,
      message: `re-export is not allowed: ${file}`,
    })),
    ...findUnreachableSources(files).map((file) => ({
      code: "unreachable-source" as const,
      file,
      message: `source file is not reachable from an entry point: ${file}`,
    })),
    ...findUnsafeTypeEscapes(files).map((file) => ({
      code: "unsafe-type-escape" as const,
      file,
      message: `unsafe type escape is not allowed: ${file}`,
    })),
    ...findUnapprovedBiomeIgnores(files).map((file) => ({
      code: "unapproved-biome-ignore" as const,
      file,
      message: `unapproved biome-ignore is not allowed: ${file}`,
    })),
    ...findEmptyCatches(files).map((file) => ({
      code: "empty-catch" as const,
      file,
      message: `empty catch is not allowed: ${file}`,
    })),
    ...findFunctionMetricIssues(files),
  ];

  return issues;
}

export function formatArchitectureResult(files: string[], issues: ArchitectureIssue[]) {
  if (issues.length > 0) {
    return ["Architecture lint failed:", ...issues.map((issue) => `- ${issue.message}`)].join("\n");
  }
  return `Architecture lint passed (${files.length} files, ${LONG_FILE_ALLOWLIST.length} long-file allowlist entries).`;
}
