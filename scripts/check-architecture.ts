import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { spawnSync } from "node:child_process";

const CHECK_ROOTS = ["src", "cloudflare/src", "benchmarks", "scripts", "e2e", "rust/solver-rs/src"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".rs"];
const MAX_FILE_LINES = 900;
const LONG_FILE_ALLOWLIST = new Set([
  "benchmarks/run-rust-rerank-benchmark.ts",
  "cloudflare/src/worker.ts",
  "rust/solver-rs/src/lib.rs",
  "src/solver.ts",
  "src/wasm/rustCore.ts",
  "src/wasm/rustMinEfSolver.ts",
]);
const TYPE_ESCAPE_BOUNDARY_ALLOWLIST = new Set([
  "benchmarks/run-rust-rerank-benchmark.ts",
  "benchmarks/run-rust-rerank-supplemental.ts",
  "cloudflare/src/worker.test.ts",
  "src/wasm/rustCore.ts",
  "src/wasm/rustPhase2Parity.test.ts",
]);

function gitTrackedFiles() {
  const result = spawnSync("git", ["ls-files", ...CHECK_ROOTS], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ls-files failed with status ${result.status}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension)));
}

function lineCount(file: string) {
  return readFileSync(file, "utf8").split(/\r?\n/).length;
}

function resolveImport(from: string, specifier: string, files: Set<string>) {
  if (!specifier.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function importGraph(files: string[]) {
  const fileSet = new Set(files);
  const graph = new Map(files.map((file) => [file, new Set<string>()]));
  const importPattern =
    /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;

  for (const file of files.filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const resolved = resolveImport(file, match[1], fileSet);
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
  const reExportPattern = /^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["'][^"']+["']/m;
  return files
    .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
    .filter((file) => reExportPattern.test(readFileSync(file, "utf8")));
}

function findUnsafeTypeEscapes(files: string[]) {
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
    .filter((file) => !TYPE_ESCAPE_BOUNDARY_ALLOWLIST.has(file))
    .filter((file) => unsafeTypePattern.test(readFileSync(file, "utf8")));
}

const files = gitTrackedFiles();
const oversizedFiles = files
  .map((file) => ({ file, lines: lineCount(file) }))
  .filter(({ file, lines }) => lines > MAX_FILE_LINES && !LONG_FILE_ALLOWLIST.has(file));
const missingLongAllowlistEntries = [...LONG_FILE_ALLOWLIST].filter((file) => !files.includes(file));
const missingTypeBoundaryAllowlistEntries = [...TYPE_ESCAPE_BOUNDARY_ALLOWLIST].filter(
  (file) => !files.includes(file),
);
const cycles = findCycles(importGraph(files));
const reExports = findReExports(files);
const unsafeTypeEscapes = findUnsafeTypeEscapes(files);

const failures = [
  ...oversizedFiles.map(({ file, lines }) => `${file} has ${lines} lines (limit ${MAX_FILE_LINES})`),
  ...missingLongAllowlistEntries.map((file) => `${file} is in LONG_FILE_ALLOWLIST but is not tracked`),
  ...missingTypeBoundaryAllowlistEntries.map(
    (file) => `${file} is in TYPE_ESCAPE_BOUNDARY_ALLOWLIST but is not tracked`,
  ),
  ...cycles.map((cycle) => `cycle: ${cycle.join(" -> ")}`),
  ...reExports.map((file) => `re-export is not allowed: ${file}`),
  ...unsafeTypeEscapes.map((file) => `unsafe type escape is not allowed: ${file}`),
];

if (failures.length > 0) {
  console.error(["Architecture lint failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
  process.exit(1);
}

console.log(
  `Architecture lint passed (${files.length} files, ${LONG_FILE_ALLOWLIST.size} long-file allowlist entries).`,
);
