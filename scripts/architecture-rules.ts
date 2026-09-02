import { existsSync, readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import {
  BIOME_IGNORE_ALLOWLIST,
  COMPLEXITY_ALLOWLIST,
  DEFAULT_MAX_FILE_LINES,
  debtFiles,
  EMPTY_CATCH_ALLOWLIST,
  LONG_FILE_ALLOWLIST,
  limitsFor,
  TYPE_ESCAPE_BOUNDARY_ALLOWLIST,
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

type AstObject = {
  type: string;
  [key: string]: unknown;
};

function isAstObject(value: unknown): value is AstObject {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function literalValue(value: unknown) {
  if (!isAstObject(value)) return null;
  const literal = value["value"];
  return typeof literal === "string" ? literal : null;
}

function exportSourceSpecifiers(program: unknown) {
  if (!isAstObject(program) || !Array.isArray(program["body"])) return [];
  return program["body"]
    .filter(isAstObject)
    .filter(
      (node) =>
        (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
        Boolean(node["source"]),
    )
    .map((node) => literalValue(node["source"]))
    .filter((value) => typeof value === "string");
}

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
    "forecast-collector/src/worker.ts",
    "stats-observer/src/worker.ts",
    "usage-guard/src/worker.ts",
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

function moduleSpecifierFromSpan(source: string, start: number, end: number) {
  const raw = source.slice(start, end).trim();
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith("`") && raw.endsWith("`"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function importCallSpecifiers(source: string) {
  const specifiers: string[] = [];
  const pattern = /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    if (match[2]) specifiers.push(match[2]);
  }
  return specifiers;
}

function importGraph(files: string[]) {
  const fileSet = new Set(files);
  const graph = new Map(files.map((file) => [file, new Set<string>()]));
  for (const file of files.filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
    const source = sourceOf(file);
    const parsed = parseSync(file, source, {
      astType: "ts",
      lang: file.endsWith(".tsx") ? "tsx" : "ts",
      sourceType: "module",
    });
    const imports = [
      ...parsed.module.staticImports.map((imported) => imported.moduleRequest.value),
      ...parsed.module.dynamicImports.map((imported) =>
        moduleSpecifierFromSpan(source, imported.moduleRequest.start, imported.moduleRequest.end),
      ),
      ...exportSourceSpecifiers(parsed.program),
      ...importCallSpecifiers(source),
    ];
    for (const imported of imports) {
      const resolved = resolveImport(file, imported, fileSet);
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
      const parsed = parseSync(file, sourceOf(file), {
        astType: "ts",
        lang: file.endsWith(".tsx") ? "tsx" : "ts",
        sourceType: "module",
      });
      return (
        exportSourceSpecifiers(parsed.program).length > 0 ||
        importsThenExportsLocalBinding(sourceOf(file))
      );
    });
}

function importsThenExportsLocalBinding(source: string) {
  const imported = new Set<string>();
  for (const match of source.matchAll(/\bimport\s+(?:type\s+)?\{([^}]+)\}\s+from\b/g)) {
    for (const rawSpecifier of match[1]?.split(",") ?? []) {
      const specifier = rawSpecifier.trim().replace(/^type\s+/, "");
      if (!specifier) continue;
      const parts = specifier.split(/\s+as\s+/);
      const local = parts.at(-1)?.trim();
      if (local) imported.add(local);
    }
  }
  for (const match of source.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s+from\b/g)) {
    if (match[1]) imported.add(match[1]);
  }
  for (const match of source.matchAll(/\bexport\s+(?:type\s+)?\{([^}]+)\}\s*;/g)) {
    for (const rawSpecifier of match[1]?.split(",") ?? []) {
      const local = rawSpecifier
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (local && imported.has(local)) return true;
    }
  }
  const defaultExport = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;/.exec(source)?.[1];
  return Boolean(defaultExport && imported.has(defaultExport));
}

export function violatesModuleBoundary(file: string, dependency: string) {
  const appViolation =
    file.startsWith("src/") &&
    (dependency.startsWith("cloudflare/") ||
      dependency.startsWith("benchmarks/") ||
      dependency.startsWith("scripts/") ||
      dependency.startsWith("e2e/"));
  const workerViolation =
    file.startsWith("cloudflare/src/") &&
    !dependency.startsWith("cloudflare/src/") &&
    !dependency.startsWith("shared/");
  const sharedViolation = file.startsWith("shared/") && !dependency.startsWith("shared/");
  return appViolation || workerViolation || sharedViolation;
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
    [String.raw`\bas\s+any\b`, doubleCastPattern, tsIgnorePattern, tsExpectErrorPattern].join("|"),
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

export function containsAdHocTextAlignment(source: string) {
  const directOffsetPattern = /(?:^|\s)(?:-?top-px|max-[A-Za-z0-9-]+:-?top-px)(?=\s|["'`])/m;
  return directOffsetPattern.test(source);
}

function findAdHocTextAlignment(files: string[]) {
  return files
    .filter((file) => file.startsWith("src/components/") && file.endsWith(".tsx"))
    .filter((file) => file !== "src/components/AlignedText.tsx")
    .filter((file) => containsAdHocTextAlignment(sourceOf(file)));
}

function findFunctionMetricIssues(files: string[]) {
  const complexityAllowlist = new Set(
    COMPLEXITY_ALLOWLIST.map((entry) => `${entry.file}\0${entry.function}`),
  );
  const issues: ArchitectureIssue[] = [];
  for (const file of files.filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
    const limits = limitsFor(file);
    for (const metric of measureFunctions(sourceOf(file), file)) {
      if (complexityAllowlist.has(`${file}\0${metric.name}`)) continue;
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
    ...findAdHocTextAlignment(files).map((file) => ({
      code: "text-alignment" as const,
      file,
      message: `direct text optical offset is not allowed; use AlignedText tokens: ${file}`,
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
