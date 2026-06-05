import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";

import {
  parseRustBenchmarkWeightSpec,
  type RustBenchmarkScenarioSource,
  rustBenchmarkWeightForScenario,
  serializeRustBenchmarkWeightSpec,
} from "./rust-benchmark-weights.ts";
import type { SolverScenario } from "./scenarios/fixed-grid";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const JSON_OUTPUT_FILE = new URL("./results/rust-runtime-benchmark.json", import.meta.url);
const CSV_OUTPUT_FILE = new URL("./results/rust-runtime-benchmark.csv", import.meta.url);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);

const HORIZON_FACTOR = 0.75;
const NORM_POWER = 3;
const TOLERANCE = 0;
const DEFAULT_REPEATS = 3;
const DEFAULT_MONTE_CARLO_RUNS = 0;
const DEFAULT_MONTE_CARLO_SEED = 20260505;
const DEFAULT_BACKENDS = ["js-phase2", "rust-phase2", "rust-phase2-rerank"] as const;
const DEFAULT_SCENARIO_IDS = [
  "R0-balanced100",
  "R0-balanced300",
  "SR0-balanced300",
  "R14e900-yellow30",
  "SR10-yellow30",
  "SR14e2900-balanced100",
  "R0-gain28Third",
  "R0-gain28One",
] as const;

type RuntimeBackend = (typeof DEFAULT_BACKENDS)[number];
type ScenarioSource = RustBenchmarkScenarioSource;

type RuntimeScenario = SolverScenario & {
  source: ScenarioSource;
};

type RuntimeRecord = {
  scenarioId: string;
  source: ScenarioSource;
  group: string;
  weight: number;
  backend: RuntimeBackend;
  repeat: number;
  status: "completed" | "error";
  elapsedMs: number;
  possible: boolean | null;
  firstAction: string | null;
  successProbability: number | null;
  routeLength: number | null;
  topCandidateCount: number | null;
  monteCarloRuns: number | null;
  errorMessage: string | null;
};

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function parseList(value: string | undefined, fallback: readonly string[]): string[] {
  const parsed = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
}

function parseBackends(value: string | undefined): RuntimeBackend[] {
  const requested = parseList(value, DEFAULT_BACKENDS);
  const valid = new Set<string>(DEFAULT_BACKENDS);
  const backends = requested.filter((backend): backend is RuntimeBackend => valid.has(backend));
  return backends.length > 0 ? backends : [...DEFAULT_BACKENDS];
}

function quantile(values: number[], q: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

function mean(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function summarizeRecords(records: RuntimeRecord[]) {
  const completed = records.filter((record) => record.status === "completed");
  const elapsed = completed.map((record) => record.elapsedMs);
  const completedWeight = sum(completed.map((record) => record.weight));
  const weightedElapsedSum = completed.reduce(
    (total, record) => total + record.elapsedMs * record.weight,
    0,
  );
  return {
    recordCount: records.length,
    completedCount: completed.length,
    errorCount: records.length - completed.length,
    meanElapsedMs: mean(elapsed),
    p50ElapsedMs: quantile(elapsed, 0.5),
    p95ElapsedMs: quantile(elapsed, 0.95),
    maxElapsedMs: elapsed.length > 0 ? Math.max(...elapsed) : null,
    completedWeight,
    weightedMeanElapsedMs: completedWeight > 0 ? weightedElapsedSum / completedWeight : null,
  };
}

function summarizeBy<T extends string>(
  records: RuntimeRecord[],
  keyFor: (record: RuntimeRecord) => T,
) {
  const keys = [...new Set(records.map(keyFor))].sort();
  return Object.fromEntries(
    keys.map((key) => [key, summarizeRecords(records.filter((record) => keyFor(record) === key))]),
  );
}

function summarizeBackendDelta(
  records: RuntimeRecord[],
  baselineBackend: RuntimeBackend,
  targetBackend: RuntimeBackend,
) {
  const byRun = new Map<string, Partial<Record<RuntimeBackend, RuntimeRecord>>>();
  for (const record of records) {
    if (record.status !== "completed") continue;
    const key = `${record.scenarioId}#${record.repeat}`;
    const row = byRun.get(key) || {};
    row[record.backend] = record;
    byRun.set(key, row);
  }

  const comparable = [...byRun.values()]
    .map((row) => {
      const baseline = row[baselineBackend];
      const target = row[targetBackend];
      if (!baseline || !target) return null;
      return {
        weight: target.weight,
        deltaMs: target.elapsedMs - baseline.elapsedMs,
        ratio: baseline.elapsedMs > 0 ? target.elapsedMs / baseline.elapsedMs : null,
      };
    })
    .filter((value): value is { weight: number; deltaMs: number; ratio: number | null } =>
      Boolean(value),
    );
  const deltas = comparable.map((item) => item.deltaMs);
  const ratios = comparable
    .map((item) => item.ratio)
    .filter((value): value is number => value !== null);
  const comparableWeight = sum(comparable.map((item) => item.weight));
  const weightedDeltaSum = comparable.reduce(
    (total, item) => total + item.deltaMs * item.weight,
    0,
  );
  return {
    baselineBackend,
    targetBackend,
    comparableCount: comparable.length,
    comparableWeight,
    meanDeltaMs: mean(deltas),
    p50DeltaMs: quantile(deltas, 0.5),
    p95DeltaMs: quantile(deltas, 0.95),
    maxDeltaMs: deltas.length > 0 ? Math.max(...deltas) : null,
    weightedMeanDeltaMs: comparableWeight > 0 ? weightedDeltaSum / comparableWeight : null,
    meanRatio: mean(ratios),
    p95Ratio: quantile(ratios, 0.95),
  };
}

function scenarioInput(scenario: SolverScenario, monteCarloRuns: number, monteCarloSeed: number) {
  return {
    start: scenario.start,
    stock: scenario.stock,
    strategy: "supply" as const,
    monteCarloRuns,
    monteCarloSeed,
  };
}

const repeats = parsePositiveInteger(process.env.RUST_RUNTIME_BENCH_REPEATS, DEFAULT_REPEATS);
const monteCarloRuns = parseNonNegativeInteger(
  process.env.RUST_RUNTIME_BENCH_MC_RUNS,
  DEFAULT_MONTE_CARLO_RUNS,
);
const monteCarloSeed = parsePositiveInteger(
  process.env.RUST_RUNTIME_BENCH_MC_SEED,
  DEFAULT_MONTE_CARLO_SEED,
);
const backends = parseBackends(process.env.RUST_RUNTIME_BENCH_BACKENDS);
const weightSpec = parseRustBenchmarkWeightSpec(
  process.env.RUST_RUNTIME_BENCH_WEIGHTS,
  process.env.RUST_RUNTIME_BENCH_WEIGHT_PROFILE,
);

await mkdir(RESULTS_DIRECTORY, { recursive: true });

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

const solverModule = (await server.ssrLoadModule(
  "/src/solver.ts",
)) as typeof import("../src/solver");
const rustProductModule = (await server.ssrLoadModule(
  "/src/wasm/rustMinEfSolver.ts",
)) as typeof import("../src/wasm/rustMinEfSolver");
const fixedGrid = (await server.ssrLoadModule(
  "/benchmarks/scenarios/fixed-grid.ts",
)) as typeof import("./scenarios/fixed-grid");
const supplemental = (await server.ssrLoadModule(
  "/benchmarks/scenarios/rerank-supplemental.ts",
)) as typeof import("./scenarios/rerank-supplemental");

const allScenarios: RuntimeScenario[] = [
  ...fixedGrid.FIXED_SAFETY_GRID.map((scenario) => ({
    ...scenario,
    source: "fixed-grid" as const,
  })),
  ...supplemental.RERANK_SUPPLEMENTAL_SCENARIOS.map((scenario) => ({
    ...scenario,
    source: "gain28-supplemental" as const,
  })),
];
const byId = new Map(allScenarios.map((scenario) => [scenario.id, scenario]));
const scenarioIds =
  process.env.RUST_RUNTIME_BENCH_SCENARIOS?.trim() === "all"
    ? allScenarios.map((scenario) => scenario.id)
    : parseList(process.env.RUST_RUNTIME_BENCH_SCENARIOS, DEFAULT_SCENARIO_IDS);
const scenarios = scenarioIds.map((id) => {
  const scenario = byId.get(id);
  if (!scenario) {
    throw new Error(
      `Missing rust runtime benchmark scenario: ${id}. Known scenarios: ${[...byId.keys()].join(", ")}`,
    );
  }
  return scenario;
});

const wasm = await readFile(WASM_URL);
const wasmDataUrl = `data:application/wasm;base64,${Buffer.from(wasm).toString("base64")}`;

const solveBackend = async (backend: RuntimeBackend, scenario: RuntimeScenario) => {
  const input = scenarioInput(scenario, monteCarloRuns, monteCarloSeed);
  switch (backend) {
    case "js-phase2":
      return solverModule.solveWithResearchCostModel(
        input,
        { kind: "availability-pnorm", horizonFactor: HORIZON_FACTOR, normPower: NORM_POWER },
        undefined,
        { toleranceOverride: TOLERANCE },
      );
    case "rust-phase2":
      return rustProductModule.solveRustPhase2(input, wasmDataUrl);
    case "rust-phase2-rerank":
      return rustProductModule.solveRustPhase2Rerank(input, wasmDataUrl);
  }
};

const firstScenario = scenarios[0];
if (!firstScenario) throw new Error("No runtime benchmark scenarios selected.");
for (const backend of backends) {
  await solveBackend(backend, firstScenario);
}

const records: RuntimeRecord[] = [];
const startedAt = performance.now();

try {
  for (const scenario of scenarios) {
    for (const backend of backends) {
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        const start = performance.now();
        try {
          const result = (await solveBackend(backend, scenario)) as {
            possible?: boolean;
            best?: {
              firstAction?: string | null;
              successProbability?: number | null;
            };
            route?: unknown[];
            topCandidates?: unknown[];
            monteCarlo?: { runs?: number | null };
          };
          records.push({
            scenarioId: scenario.id,
            source: scenario.source,
            group: scenario.group,
            weight: rustBenchmarkWeightForScenario(scenario, weightSpec),
            backend,
            repeat,
            status: "completed",
            elapsedMs: performance.now() - start,
            possible: Boolean(result.possible),
            firstAction: result.best?.firstAction ?? null,
            successProbability: result.best?.successProbability ?? null,
            routeLength: result.route?.length ?? null,
            topCandidateCount: result.topCandidates?.length ?? null,
            monteCarloRuns: result.monteCarlo?.runs ?? null,
            errorMessage: null,
          });
        } catch (error) {
          records.push({
            scenarioId: scenario.id,
            source: scenario.source,
            group: scenario.group,
            weight: rustBenchmarkWeightForScenario(scenario, weightSpec),
            backend,
            repeat,
            status: "error",
            elapsedMs: performance.now() - start,
            possible: null,
            firstAction: null,
            successProbability: null,
            routeLength: null,
            topCandidateCount: null,
            monteCarloRuns: null,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    options: {
      repeats,
      monteCarloRuns,
      monteCarloSeed,
      backends,
      scenarioIds,
      weightSpec: serializeRustBenchmarkWeightSpec(weightSpec),
    },
    elapsedMs: Math.round(performance.now() - startedAt),
    summary: summarizeRecords(records),
    byBackend: summarizeBy(records, (record) => record.backend),
    backendComparisons: {
      "rust-phase2-rerank_vs_rust-phase2": summarizeBackendDelta(
        records,
        "rust-phase2",
        "rust-phase2-rerank",
      ),
      "rust-phase2_vs_js-phase2": summarizeBackendDelta(records, "js-phase2", "rust-phase2"),
    },
    byScenario: summarizeBy(records, (record) => record.scenarioId),
    bySource: summarizeBy(records, (record) => record.source),
    records,
  };

  const csvHeaders = [
    "scenarioId",
    "source",
    "group",
    "weight",
    "backend",
    "repeat",
    "status",
    "elapsedMs",
    "possible",
    "firstAction",
    "successProbability",
    "routeLength",
    "topCandidateCount",
    "monteCarloRuns",
    "errorMessage",
  ];
  const csv = [
    csvHeaders.join(","),
    ...records.map((record) =>
      csvHeaders.map((header) => csvEscape(record[header as keyof RuntimeRecord])).join(","),
    ),
  ].join("\n");

  await writeFile(JSON_OUTPUT_FILE, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(CSV_OUTPUT_FILE, `${csv}\n`);

  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${JSON_OUTPUT_FILE.pathname}`);
  console.log(`Wrote ${CSV_OUTPUT_FILE.pathname}`);
} finally {
  await server.close();
}
