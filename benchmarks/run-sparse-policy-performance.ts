import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";

import { envValue, parseList, parsePositiveInteger } from "./runner-utils.ts";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const reportId = envValue("SPARSE_PI_PERF_REPORT_ID") || "default";
if (!/^[a-z0-9-]+$/i.test(reportId)) throw new Error("Invalid sparse PI performance report id.");
const OUTPUT_FILE = new URL(
  `./results/sparse-policy-performance-${reportId}.json`,
  import.meta.url,
);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);
const DEFAULT_SCENARIOS = ["R10-balanced300", "SR0-balanced300"] as const;

const scenarioIds = parseList(envValue("SPARSE_PI_PERF_SCENARIOS"), DEFAULT_SCENARIOS);
const repeats = parsePositiveInteger(envValue("SPARSE_PI_PERF_REPEATS"), 5);
const maxIterations = parsePositiveInteger(envValue("SPARSE_PI_MAX_ITERATIONS"), 40);
const acceptIterationBudget = envValue("SPARSE_PI_ACCEPT_ITERATION_BUDGET") === "1";
const wasm = await readFile(WASM_URL);
await mkdir(RESULTS_DIRECTORY, { recursive: true });

async function instantiate() {
  const result = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  return result instanceof WebAssembly.Instance ? result : result.instance;
}

function percentileNearestRank(samples: readonly number[], quantile: number) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(sorted.length * quantile));
  return sorted[Math.min(rank - 1, sorted.length - 1)] ?? null;
}

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

try {
  const sparse = (await server.ssrLoadModule(
    "/benchmarks/sparse-policy-iteration.ts",
  )) as typeof import("./sparse-policy-iteration");
  const rustPhase2 = (await server.ssrLoadModule(
    "/src/wasm/rustPhase2Core.ts",
  )) as typeof import("../src/wasm/rustPhase2Core");
  const loader = (await server.ssrLoadModule(
    "/src/wasm/rustLoader.ts",
  )) as typeof import("../src/wasm/rustLoader");
  const fixed = (await server.ssrLoadModule(
    "/benchmarks/scenarios/fixed-grid.ts",
  )) as typeof import("./scenarios/fixed-grid");
  const byId = new Map(fixed.FIXED_SAFETY_GRID.map((scenario) => [scenario.id, scenario]));

  const records = [];
  for (const scenarioId of scenarioIds) {
    const scenario = byId.get(scenarioId);
    if (!scenario) throw new Error(`Unknown sparse PI performance scenario: ${scenarioId}`);
    const baselineInstance = await instantiate();
    const baseline = rustPhase2.createRustPhase2Solver(
      loader.rustCoreExportsFromInstance(baselineInstance),
    );
    baseline.configureMemoTier(22);
    const candidateInstance = await instantiate();
    const candidateExports = loader.rustCoreExportsFromInstance(candidateInstance);
    const baselineSamplesMs: number[] = [];
    const candidateSamplesMs: number[] = [];
    const candidateOutcomes: string[] = [];

    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const baselineStartedAt = performance.now();
      baseline.buildPolicy(scenario.start, scenario.stock, 0.75, 3, 0);
      baselineSamplesMs.push(performance.now() - baselineStartedAt);

      const candidateStartedAt = performance.now();
      const result = sparse.solveSparsePolicyIteration(
        candidateExports,
        { start: scenario.start, stock: scenario.stock, strategy: "supply" },
        {
          acceptIterationBudget,
          maxIterations,
          maxStates: 1_200_000,
          memoTier: 22,
          timeBudgetMs: 300_000,
        },
      );
      candidateSamplesMs.push(performance.now() - candidateStartedAt);
      candidateOutcomes.push(result.outcome);
    }

    records.push({
      scenarioId,
      baseline: {
        samplesMs: baselineSamplesMs,
        coldMs: baselineSamplesMs[0],
        warmP50Ms: percentileNearestRank(baselineSamplesMs.slice(1), 0.5),
        warmP95Ms: percentileNearestRank(baselineSamplesMs.slice(1), 0.95),
      },
      candidate: {
        outcomes: candidateOutcomes,
        samplesMs: candidateSamplesMs,
        coldMs: candidateSamplesMs[0],
        warmP50Ms: percentileNearestRank(candidateSamplesMs.slice(1), 0.5),
        warmP95Ms: percentileNearestRank(candidateSamplesMs.slice(1), 0.95),
      },
    });
    console.log(
      `${scenarioId}: phase2=${baselineSamplesMs.map((value) => value.toFixed(1)).join(",")} sparse=${candidateSamplesMs.map((value) => value.toFixed(1)).join(",")}`,
    );
  }

  await writeFile(
    OUTPUT_FILE,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        kind: "sparse-policy-performance-screening",
        reportId,
        measurementProtocol: {
          latency: {
            discardColdSamples: 1,
            estimator: "nearest_rank_ceil",
            quantiles: [0.5, 0.95],
            repeats,
          },
        },
        options: { acceptIterationBudget, maxIterations, scenarioIds },
        records,
        version: 1,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`Wrote ${OUTPUT_FILE.pathname}`);
} finally {
  await server.close();
}
