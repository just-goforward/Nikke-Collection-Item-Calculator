import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "vite";

import { EXPECTED_28_DAY_GAIN } from "../src/solver/domain";
import type { RustPrioritizedSparsePiResult } from "./rust-prioritized-sparse-pi";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const OUTPUT_FILE = new URL("./results/rust-prioritized-sparse-pi.json", import.meta.url);
const CANDIDATE_URL = new URL("../output/solver_rs-prioritized-sparse-pi.wasm", import.meta.url);
const PRODUCT_URL = new URL("../public/solver_rs.wasm", import.meta.url);
const COMPLETED_FIXTURES = [
  {
    id: "R0-semantic-60-120-900",
    start: { grade: "R" as const, level: 0, exp: 0 },
    stock: { blue: 60, purple: 120, yellow: 900 },
  },
  { id: "R14e900-yellow30" },
  { id: "SR5-blue30" },
  { id: "SR10-yellow10" },
] as const;
const REPEATS = 5;

function percentileNearestRank(samples: readonly number[], quantile: number) {
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(sorted.length * quantile));
  return sorted[Math.min(rank - 1, sorted.length - 1)] ?? null;
}

function summarize(samplesMs: readonly number[]) {
  const warm = samplesMs.slice(1);
  return {
    samplesMs,
    coldMs: samplesMs[0] ?? null,
    warmP50Ms: percentileNearestRank(warm, 0.5),
    warmP95Ms: percentileNearestRank(warm, 0.95),
    repeats: samplesMs.length,
  };
}

function close(actual: number, expected: number, tolerance: number) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

const candidateBytes = await readFile(CANDIDATE_URL);
const productBytes = await readFile(PRODUCT_URL);
await mkdir(RESULTS_DIRECTORY, { recursive: true });

async function instantiate(bytes: Uint8Array) {
  const result = (await WebAssembly.instantiate(bytes)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  return result instanceof WebAssembly.Instance ? result : result.instance;
}

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

try {
  const loader = (await server.ssrLoadModule(
    "/src/wasm/rustLoader.ts",
  )) as typeof import("../src/wasm/rustLoader");
  const minEfModule = (await server.ssrLoadModule(
    "/src/wasm/rustMinEfCore.ts",
  )) as typeof import("../src/wasm/rustMinEfCore");
  const candidateModule = (await server.ssrLoadModule(
    "/benchmarks/rust-prioritized-sparse-pi.ts",
  )) as typeof import("./rust-prioritized-sparse-pi");
  const domain = (await server.ssrLoadModule(
    "/src/solver/domain.ts",
  )) as typeof import("../src/solver/domain");
  const fixed = (await server.ssrLoadModule(
    "/benchmarks/scenarios/fixed-grid.ts",
  )) as typeof import("./scenarios/fixed-grid");
  const byId = new Map(fixed.FIXED_SAFETY_GRID.map((scenario) => [scenario.id, scenario]));

  const semanticRecords = [];
  for (const fixture of COMPLETED_FIXTURES) {
    const scenario = "start" in fixture ? fixture : byId.get(fixture.id);
    if (!scenario) throw new Error(`Missing prioritized sparse PI fixture: ${fixture.id}`);
    const input = { start: scenario.start, stock: scenario.stock, strategy: "supply" as const };

    const minEfInstance = await instantiate(candidateBytes);
    const minEf = minEfModule.createRustMinEfSolver(
      loader.rustCoreExportsFromInstance(minEfInstance),
    );
    minEf.configureMemoTier(21);
    const reference = minEf.solveRootWithCandidates(
      scenario.start,
      scenario.stock,
      0.75,
      3,
      0,
    ).root;

    const candidateInstance = await instantiate(candidateBytes);
    const result = candidateModule.solveRustPrioritizedSparsePi(
      loader.rustCoreExportsFromInstance(candidateInstance),
      input,
      {
        maxPasses: 80,
        maxStates: 1_200_000,
        maxUpdatesPerPass: 1_000_000,
        memoTier: 22,
      },
    );
    const parity = {
      completed: result.outcome === "completed",
      action: result.finalAction === reference.firstAction,
      success: close(result.success, reference.successProbability, 1e-12),
      cost: close(result.cost, reference.expectedCost, 1e-12),
      blue: close(result.vector.blue, reference.vector.blue, 1e-10),
      purple: close(result.vector.purple, reference.vector.purple, 1e-10),
      yellow: close(result.vector.yellow, reference.vector.yellow, 1e-10),
      probabilityGap: result.probabilityGap <= 1e-12,
    };
    semanticRecords.push({ fixtureId: fixture.id, reference, candidate: result, parity });
    console.log(
      `${fixture.id}: ${result.outcome} action=${result.finalAction} states=${result.peakStates} ms=${result.elapsedMs.toFixed(1)}`,
    );
  }

  const r10 = byId.get("R10-balanced300");
  if (!r10) throw new Error("Missing R10-balanced300 fixture.");
  const r10Input = { start: r10.start, stock: r10.stock, strategy: "supply" as const };
  const baselineSamplesMs: number[] = [];
  const candidateSamplesMs: number[] = [];
  const boundedResults: RustPrioritizedSparsePiResult[] = [];
  const baselineInstance = await instantiate(candidateBytes);
  const baselineExports = loader.rustCoreExportsFromInstance(baselineInstance);
  const candidateInstance = await instantiate(candidateBytes);
  const candidateExports = loader.rustCoreExportsFromInstance(candidateInstance);

  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const runBaseline = () => {
      baselineExports.configureMemo?.(22);
      const startedAt = performance.now();
      baselineExports.solveCore?.(
        domain.stateIdNormalized(r10.start),
        r10.stock.blue,
        r10.stock.purple,
        r10.stock.yellow,
        EXPECTED_28_DAY_GAIN.blue,
        EXPECTED_28_DAY_GAIN.purple,
        EXPECTED_28_DAY_GAIN.yellow,
        0.75,
        3,
        0,
      );
      baselineSamplesMs.push(performance.now() - startedAt);
    };
    const runCandidate = () => {
      const result = candidateModule.solveRustPrioritizedSparsePi(candidateExports, r10Input, {
        maxPasses: 4,
        maxStates: 1_200_000,
        maxUpdatesPerPass: 256,
        memoTier: 22,
      });
      candidateSamplesMs.push(result.elapsedMs);
      boundedResults.push(result);
    };
    if (repeat % 2 === 0) {
      runBaseline();
      runCandidate();
    } else {
      runCandidate();
      runBaseline();
    }
  }

  const exactClosureInstance = await instantiate(candidateBytes);
  const exactClosure = candidateModule.solveRustPrioritizedSparsePi(
    loader.rustCoreExportsFromInstance(exactClosureInstance),
    r10Input,
    {
      maxPasses: 40,
      maxStates: 1_200_000,
      maxUpdatesPerPass: 1_000_000,
      memoTier: 22,
    },
  );
  const baselineLatency = summarize(baselineSamplesMs);
  const candidateLatency = summarize(candidateSamplesMs);
  const warmRatio =
    baselineLatency.warmP95Ms && candidateLatency.warmP95Ms
      ? candidateLatency.warmP95Ms / baselineLatency.warmP95Ms
      : null;

  const report = {
    generatedAt: new Date().toISOString(),
    kind: "rust-prioritized-sparse-pi-study",
    version: 1,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    artifacts: {
      product: {
        bytes: (await stat(PRODUCT_URL)).size,
        sha256: createHash("sha256").update(productBytes).digest("hex"),
      },
      candidate: {
        bytes: (await stat(CANDIDATE_URL)).size,
        sha256: createHash("sha256").update(candidateBytes).digest("hex"),
        feature: "research-sparse-pi",
      },
      productBudgetBytes: 115_000,
    },
    contract: {
      priority: "maximum_discovered_root_path_probability",
      completedMeaning: "no_strict_improvement_in_exhausted_discovered_eligible_closure",
      tolerance: 0,
      maxStates: 1_200_000,
    },
    semanticRecords,
    r10Screening: {
      options: { maxPasses: 4, maxUpdatesPerPass: 256, repeats: REPEATS },
      baselineLatency,
      candidateLatency,
      warmP95Ratio: warmRatio,
      continuationGatePassed:
        warmRatio !== null &&
        warmRatio <= 1.5 &&
        boundedResults.every((result) => result.outcome === "iteration_budget_exceeded"),
      results: boundedResults,
    },
    r10ExactClosure: exactClosure,
    decisions: {
      semanticGatePassed: semanticRecords.every((record) =>
        Object.values(record.parity).every(Boolean),
      ),
      exactFallbackCompleted: exactClosure.outcome === "completed",
      productSizeGatePassed: candidateBytes.byteLength <= 115_000,
    },
  };
  await writeFile(OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUTPUT_FILE.pathname}`);
} finally {
  await server.close();
}
