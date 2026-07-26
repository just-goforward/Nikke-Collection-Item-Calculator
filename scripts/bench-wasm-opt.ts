import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { SolverInput } from "../src/types.ts";

type BuildName = "base" | "oz";
type Backend = "rust-min-ef" | "rust-phase2";
type Outcome = "completed" | "memo_full" | "budget_exceeded" | "failure";
type TimedOutcome = {
  backend: Backend;
  elapsedMs: number;
  outcome: Outcome;
  scenario: string;
};
type BuildSample = {
  build: BuildName;
  records: TimedOutcome[];
};
type CompileSample = {
  build: BuildName;
  elapsedMs: number;
};

const BINARYEN_VERSION = "131.0.0";
const DEFAULT_REPEATS = 31;
const SIZE_REDUCTION_TARGET = 0.15;
const RUNTIME_PERCENT_LIMIT = 0.05;
const RUNTIME_ABSOLUTE_LIMIT_MS = 2;
const selfPath = fileURLToPath(import.meta.url);
const basePath = fileURLToPath(new URL("../public/solver_rs.wasm", import.meta.url));

const scenarios: Array<{ id: string; input: SolverInput }> = [
  {
    id: "R0-observed-low-yellow",
    input: {
      start: { grade: "R", level: 0, exp: 0 },
      stock: { blue: 300, purple: 70, yellow: 30 },
      strategy: "supply",
      monteCarloRuns: 0,
    },
  },
  {
    id: "SR10-balanced",
    input: {
      start: { grade: "SR", level: 10, exp: 0 },
      stock: { blue: 300, purple: 150, yellow: 150 },
      strategy: "supply",
      monteCarloRuns: 0,
    },
  },
  {
    id: "R0-balanced-observed-high",
    input: {
      start: { grade: "R", level: 0, exp: 0 },
      stock: { blue: 300, purple: 150, yellow: 150 },
      strategy: "supply",
      monteCarloRuns: 0,
    },
  },
];

function repeats() {
  const configured = Number(process.env["WASM_OPT_REPEATS"]);
  return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : DEFAULT_REPEATS;
}

function outcomeFrom(error: unknown): Outcome {
  if (error && typeof error === "object" && "status" in error) {
    if (error.status === 2) return "memo_full";
    if (error.status === 1) return "budget_exceeded";
  }
  return "failure";
}

function quantile(values: number[], q: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? null;
}

async function dataUrl(path: string) {
  const bytes = await readFile(path);
  return `data:application/wasm;base64,${bytes.toString("base64")}`;
}

async function measureSolve(
  modules: {
    minEf: typeof import("../src/wasm/rustMinEfSolver.ts");
    phase2: typeof import("../src/wasm/rustPhase2ProductSolver.ts");
  },
  backend: Backend,
  input: SolverInput,
  wasmUrl: string,
) {
  const startedAt = performance.now();
  try {
    if (backend === "rust-min-ef") {
      await modules.minEf.solveRustMinEf(input, wasmUrl);
    } else {
      await modules.phase2.solveRustPhase2(input, wasmUrl);
    }
    return { elapsedMs: performance.now() - startedAt, outcome: "completed" as const };
  } catch (error) {
    return { elapsedMs: performance.now() - startedAt, outcome: outcomeFrom(error) };
  }
}

async function runHotChild(build: BuildName, wasmPath: string) {
  const wasmUrl = await dataUrl(wasmPath);
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "error",
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });

  try {
    const modules = {
      minEf: (await server.ssrLoadModule(
        "/src/wasm/rustMinEfSolver.ts",
      )) as typeof import("../src/wasm/rustMinEfSolver.ts"),
      phase2: (await server.ssrLoadModule(
        "/src/wasm/rustPhase2ProductSolver.ts",
      )) as typeof import("../src/wasm/rustPhase2ProductSolver.ts"),
    };
    const warmup = scenarios[0];
    if (!warmup) throw new Error("No WASM optimization scenarios configured.");
    await measureSolve(modules, "rust-min-ef", warmup.input, wasmUrl);
    await measureSolve(modules, "rust-phase2", warmup.input, wasmUrl);

    const records: TimedOutcome[] = [];
    for (const scenario of scenarios) {
      for (const backend of ["rust-min-ef", "rust-phase2"] as const) {
        records.push({
          backend,
          scenario: scenario.id,
          ...(await measureSolve(modules, backend, scenario.input, wasmUrl)),
        });
      }
    }
    emitChildResult({ build, records } satisfies BuildSample);
  } finally {
    await server.close();
  }
}

async function runCompileChild(wasmPath: string) {
  const bytes = await readFile(wasmPath);
  const startedAt = performance.now();
  await WebAssembly.compile(bytes);
  emitChildResult({ elapsedMs: performance.now() - startedAt });
}

function emitChildResult(result: unknown) {
  process.stdout.write(`WASM_OPT_SAMPLE:${JSON.stringify(result)}\n`);
}

function optimizeCandidate(candidatePath: string) {
  const npxCli = resolve(dirname(process.execPath), "node_modules/npm/bin/npx-cli.js");
  const result = spawnSync(
    process.execPath,
    [
      npxCli,
      "--yes",
      `--package=binaryen@${BINARYEN_VERSION}`,
      "wasm-opt",
      basePath,
      "-Oz",
      "--emit-target-features",
      "-o",
      candidatePath,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(`wasm-opt failed:\n${result.error?.message || result.stderr || result.stdout}`);
  }
}

function readChildResult<T>(args: string[]) {
  const result = spawnSync(process.execPath, [selfPath, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`WASM benchmark child failed:\n${result.stderr || result.stdout}`);
  }
  const line = result.stdout
    .split(/\r?\n/)
    .reverse()
    .find((entry: string) => entry.startsWith("WASM_OPT_SAMPLE:"));
  if (!line) throw new Error(`WASM benchmark child returned no sample:\n${result.stdout}`);
  return JSON.parse(line.slice("WASM_OPT_SAMPLE:".length)) as T;
}

function buildOrder(repeat: number): readonly BuildName[] {
  return repeat % 2 === 0 ? ["base", "oz"] : ["oz", "base"];
}

function summarizeCompile(samples: CompileSample[]) {
  return Object.fromEntries(
    (["base", "oz"] as const).map((build) => {
      const values = samples
        .filter((sample) => sample.build === build)
        .map((sample) => sample.elapsedMs);
      return [build, { p50Ms: quantile(values, 0.5), p95Ms: quantile(values, 0.95) }];
    }),
  );
}

function summarizeHot(samples: BuildSample[]) {
  return Object.fromEntries(
    scenarios.flatMap((scenario) =>
      (["rust-min-ef", "rust-phase2"] as const).flatMap((backend) =>
        (["base", "oz"] as const).map((build) => {
          const records = samples
            .filter((sample) => sample.build === build)
            .flatMap((sample) => sample.records)
            .filter((record) => record.scenario === scenario.id && record.backend === backend);
          const values = records.map((record) => record.elapsedMs);
          return [
            `${scenario.id}:${backend}:${build}`,
            {
              build,
              backend,
              scenario: scenario.id,
              outcomes: Object.fromEntries(
                [...new Set(records.map((record) => record.outcome))].map((outcome) => [
                  outcome,
                  records.filter((record) => record.outcome === outcome).length,
                ]),
              ),
              p50Ms: quantile(values, 0.5),
              p95Ms: quantile(values, 0.95),
            },
          ];
        }),
      ),
    ),
  );
}

function runtimeReview(
  summary: Record<string, { outcomes: Record<string, number>; p95Ms: number | null }>,
) {
  const findings: string[] = [];
  for (const scenario of scenarios) {
    for (const backend of ["rust-min-ef", "rust-phase2"] as const) {
      const base = summary[`${scenario.id}:${backend}:base`];
      const oz = summary[`${scenario.id}:${backend}:oz`];
      if (!base || !oz || base.p95Ms === null || oz.p95Ms === null) continue;
      if (JSON.stringify(base.outcomes) !== JSON.stringify(oz.outcomes)) {
        findings.push(`${scenario.id}:${backend} changed outcome distribution`);
      }
      const allowedP95 =
        base.p95Ms + Math.max(RUNTIME_ABSOLUTE_LIMIT_MS, base.p95Ms * RUNTIME_PERCENT_LIMIT);
      if (oz.p95Ms > allowedP95) {
        findings.push(
          `${scenario.id}:${backend} Oz p95 ${oz.p95Ms.toFixed(2)}ms exceeds ${allowedP95.toFixed(2)}ms`,
        );
      }
    }
  }
  return findings;
}

async function runParent() {
  const candidatePath =
    process.env["WASM_CANDIDATE_PATH"] ??
    resolve(tmpdir(), `solver-rs-binaryen-${BINARYEN_VERSION}-Oz.wasm`);
  if (!process.env["WASM_CANDIDATE_PATH"]) optimizeCandidate(candidatePath);

  const compileSamples: CompileSample[] = [];
  const hotSamples: BuildSample[] = [];
  const paths = { base: basePath, oz: candidatePath } as const;
  for (let repeat = 0; repeat < repeats(); repeat += 1) {
    for (const build of buildOrder(repeat)) {
      const compile = readChildResult<{ elapsedMs: number }>(["--compile-child", paths[build]]);
      compileSamples.push({ build, elapsedMs: compile.elapsedMs });
      hotSamples.push(readChildResult<BuildSample>(["--hot-child", build, paths[build]]));
    }
  }

  const [baseSize, candidateSize] = await Promise.all([
    stat(basePath).then((entry) => entry.size),
    stat(candidatePath).then((entry) => entry.size),
  ]);
  const hotSummary = summarizeHot(hotSamples);
  const sizeReduction = 1 - candidateSize / baseSize;
  const report = {
    generatedAt: new Date().toISOString(),
    mode: "report-only",
    binaryenVersion: BINARYEN_VERSION,
    repeats: repeats(),
    files: {
      base: { path: basePath, bytes: baseSize },
      oz: { path: candidatePath, bytes: candidateSize },
    },
    sizeReduction,
    sizeTargetMet: sizeReduction >= SIZE_REDUCTION_TARGET,
    coldCompile: summarizeCompile(compileSamples),
    hotSolve: hotSummary,
    runtimeReview: runtimeReview(hotSummary),
    adoptionBlockers: [
      "Chrome, Firefox, and WebKit browser measurements are not part of this Node harness.",
      "Real Android and iOS measurements are required before making -Oz the build default.",
      "Parity and min-E[f] golden tests must be rerun against the exact candidate artifact.",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
}

const mode = process.argv[2];
if (mode === "--compile-child") {
  const wasmPath = process.argv[3];
  if (!wasmPath) throw new Error("Missing compile child WASM path.");
  await runCompileChild(wasmPath);
} else if (mode === "--hot-child") {
  const build = process.argv[3];
  const wasmPath = process.argv[4];
  if ((build !== "base" && build !== "oz") || !wasmPath) {
    throw new Error("Missing hot child build name or WASM path.");
  }
  await runHotChild(build, wasmPath);
} else {
  await runParent();
}
