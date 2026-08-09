import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  fingerprintResearchArtifact,
  type ResearchProvenance,
  sameResearchIdentity,
} from "./research-provenance.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRODUCT_PATH = "public/solver_rs.wasm";
const CANDIDATE_PATH = "output/solver_rs-branch-bound-audit.wasm";
const OUTPUT_URL = new URL("./results/min-ef-branch-bound-b2-latency-final.json", import.meta.url);
const CHECKPOINT_URL = new URL(
  "./results/min-ef-branch-bound-b2-latency-final.checkpoint.json",
  import.meta.url,
);
const CHILD_MARKER = "MIN_EF_B2_LATENCY_SAMPLE:";
const SELF_PATH = fileURLToPath(import.meta.url);

type Build = "product" | "candidate";
type Scenario = {
  id: string;
  memoTier: number;
  stateId: number;
  stock: readonly [blue: number, purple: number, yellow: number];
};

type SolverExports = WebAssembly.Exports & {
  configureMinEfMemo: (tier: number) => void;
  configureNodeBudget?: (budget: number) => void;
  getSolveStatus: () => number;
  memory: WebAssembly.Memory;
  minEfAction: () => number;
  minEfExpectedCost: () => number;
  minEfMaxSuccessProb: () => number;
  minEfNodeCount: () => number;
  minEfSuccessProb: () => number;
  minEfVecB: () => number;
  minEfVecP: () => number;
  minEfVecY: () => number;
  solveMinEf: (
    stateId: number,
    blue: number,
    purple: number,
    yellow: number,
    horizonFactor: number,
    normPower: number,
    tolerance: number,
  ) => void;
};

type CandidateExports = SolverExports & {
  configureMinEfBranchBoundPruning: (mode: number) => number;
  configureMinEfBranchBoundSuccessMemo: (tier: number) => void;
};

const SCENARIOS: Scenario[] = [
  {
    id: "semantic-dominance-cap-tier21",
    memoTier: 21,
    stateId: 0,
    stock: [60, 120, 900],
  },
  {
    id: "R0-balanced250-tier22",
    memoTier: 22,
    stateId: 0,
    stock: [250, 250, 250],
  },
] as const;

const CONTRACT = {
  candidate: "B2-compact-maximum-success-oracle",
  candidateMode: 2,
  horizonFactor: 0.75,
  normPower: 3,
  tolerance: 0,
  nodeBudget: 20_000_000,
  repeats: 31,
  order: "ABBA by paired repeat",
  phase: "allocation-warm",
  warmupSolves: 1,
  percentileEstimator: "nearest_rank_ceil",
  quantile: 0.95,
  latencyGate: { relativeFactor: 1.15, absoluteMarginMs: 50 },
  scenarios: SCENARIOS,
} as const;

type SemanticSnapshot = {
  action: number;
  maximumSuccessBits: string;
  successBits: string;
  vectorBits: [string, string, string];
  expectedCostBits: string;
};

type Sample = {
  repeat: number;
  build: Build;
  scenarioId: string;
  elapsedMs: number;
  memoryGrowthBytes: number;
  nodeCount: number;
  semantic: SemanticSnapshot;
};

type Checkpoint = {
  kind: "min-ef-branch-bound-b2-latency-checkpoint";
  version: 1;
  provenance: ResearchProvenance;
  samples: Sample[];
};

type FinalReport = {
  kind: "min-ef-branch-bound-b2-latency";
  version: 1;
  generatedAt: string;
  provenance: ResearchProvenance;
  productWasm: ReturnType<typeof fingerprintResearchArtifact>;
  contract: typeof CONTRACT;
  samples: Sample[];
  scenarios: Record<
    string,
    {
      product: ReturnType<typeof summarize>;
      candidate: ReturnType<typeof summarize>;
      semanticParity: boolean;
      p95LimitMs: number;
      passed: boolean;
    }
  >;
  gate: { passed: boolean; blockers: string[] };
};

async function runParent() {
  const provenance = collectResearchProvenance({
    repoRoot: REPO_ROOT,
    studyId: "min-ef-branch-bound-b2-allocation-warm-latency",
    protocolVersion: 1,
    contract: CONTRACT,
    sourceFiles: [
      "benchmarks/run-min-ef-branch-bound-b2-latency.ts",
      "benchmarks/research-provenance.ts",
      "scripts/build-solver-wasm-branch-bound.ts",
      "rust/solver-rs/Cargo.toml",
      "rust/solver-rs/src/constants.rs",
      "rust/solver-rs/src/cost.rs",
      "rust/solver-rs/src/lib.rs",
      "rust/solver-rs/src/minef.rs",
      "rust/solver-rs/src/state.rs",
      "rust/solver-rs/src/status.rs",
      "rust/solver-rs/src/transition.rs",
    ],
    wasmPath: CANDIDATE_PATH,
  });
  assertResearchReportCanBeWritten(await readJson<FinalReport>(OUTPUT_URL), provenance);
  const checkpoint = await readCheckpoint(provenance);
  const samples = checkpoint?.samples ?? [];

  for (let repeat = 0; repeat < CONTRACT.repeats; repeat += 1) {
    for (const build of buildOrder(repeat)) {
      for (const scenario of SCENARIOS) {
        if (hasSample(samples, repeat, build, scenario.id)) continue;
        const sample = runChild(build, scenario, repeat);
        samples.push(sample);
        await writeCheckpoint(provenance, samples);
        console.log(
          `${repeat + 1}/${CONTRACT.repeats} ${build} ${scenario.id} ${sample.elapsedMs.toFixed(2)}ms`,
        );
      }
    }
  }

  const scenarioSummary: FinalReport["scenarios"] = {};
  const blockers: string[] = [];
  for (const scenario of SCENARIOS) {
    const productSamples = selectSamples(samples, "product", scenario.id);
    const candidateSamples = selectSamples(samples, "candidate", scenario.id);
    const product = summarize(productSamples);
    const candidate = summarize(candidateSamples);
    const semanticParity =
      semanticSet(productSamples).size === 1 &&
      semanticSet(candidateSamples).size === 1 &&
      [...semanticSet(productSamples)][0] === [...semanticSet(candidateSamples)][0];
    const p95LimitMs = Math.max(
      product.p95Ms * CONTRACT.latencyGate.relativeFactor,
      product.p95Ms + CONTRACT.latencyGate.absoluteMarginMs,
    );
    const passed = semanticParity && candidate.p95Ms <= p95LimitMs;
    if (!semanticParity) blockers.push(`${scenario.id}: semantic snapshot mismatch`);
    if (candidate.p95Ms > p95LimitMs) {
      blockers.push(
        `${scenario.id}: candidate p95 ${candidate.p95Ms.toFixed(2)}ms exceeds ${p95LimitMs.toFixed(2)}ms`,
      );
    }
    scenarioSummary[scenario.id] = {
      product,
      candidate,
      semanticParity,
      p95LimitMs,
      passed,
    };
  }

  const report: FinalReport = {
    kind: "min-ef-branch-bound-b2-latency",
    version: 1,
    generatedAt: new Date().toISOString(),
    provenance,
    productWasm: fingerprintResearchArtifact(REPO_ROOT, PRODUCT_PATH),
    contract: CONTRACT,
    samples,
    scenarios: scenarioSummary,
    gate: { passed: blockers.length === 0, blockers },
  };
  await writeFile(OUTPUT_URL, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ scenarios: scenarioSummary, gate: report.gate }, null, 2));
}

function runChild(build: Build, scenario: Scenario, repeat: number): Sample {
  const wasmPath = resolve(REPO_ROOT, build === "product" ? PRODUCT_PATH : CANDIDATE_PATH);
  const result = spawnSync(
    process.execPath,
    [SELF_PATH, "--child", build, scenario.id, wasmPath, String(repeat)],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Latency child failed (${build}/${scenario.id}):\n${result.stderr || result.stdout}`,
    );
  }
  const line = result.stdout.split(/\r?\n/u).find((entry) => entry.startsWith(CHILD_MARKER));
  if (!line) throw new Error(`Latency child returned no sample:\n${result.stdout}`);
  return JSON.parse(line.slice(CHILD_MARKER.length)) as Sample;
}

async function runChildProcess(build: Build, scenario: Scenario, wasmPath: string, repeat: number) {
  const module = await WebAssembly.compile(await readFile(wasmPath));
  const instance = await WebAssembly.instantiate(module);
  let exports: SolverExports;
  if (build === "candidate") {
    const candidate = requireCandidateExports(instance.exports);
    candidate.configureMinEfBranchBoundSuccessMemo(scenario.memoTier);
    if (candidate.configureMinEfBranchBoundPruning(CONTRACT.candidateMode) !== 1) {
      throw new Error("Candidate rejected compact branch-bound mode.");
    }
    exports = candidate;
  } else {
    exports = requireSolverExports(instance.exports);
  }
  exports.configureMinEfMemo(scenario.memoTier);
  exports.configureNodeBudget?.(CONTRACT.nodeBudget);

  runSolve(exports, scenario);
  const memoryBefore = exports.memory.buffer.byteLength;
  const startedAt = performance.now();
  runSolve(exports, scenario);
  const elapsedMs = performance.now() - startedAt;
  const memoryAfter = exports.memory.buffer.byteLength;
  const sample: Sample = {
    repeat,
    build,
    scenarioId: scenario.id,
    elapsedMs,
    memoryGrowthBytes: memoryAfter - memoryBefore,
    nodeCount: exports.minEfNodeCount(),
    semantic: semanticSnapshot(exports),
  };
  process.stdout.write(`${CHILD_MARKER}${JSON.stringify(sample)}\n`);
}

function runSolve(exports: SolverExports, scenario: Scenario) {
  exports.solveMinEf(
    scenario.stateId,
    scenario.stock[0],
    scenario.stock[1],
    scenario.stock[2],
    CONTRACT.horizonFactor,
    CONTRACT.normPower,
    CONTRACT.tolerance,
  );
  const status = exports.getSolveStatus();
  if (status !== 0) throw new Error(`${scenario.id} returned status ${status}.`);
}

function semanticSnapshot(exports: SolverExports): SemanticSnapshot {
  return {
    action: exports.minEfAction(),
    maximumSuccessBits: bits(exports.minEfMaxSuccessProb()),
    successBits: bits(exports.minEfSuccessProb()),
    vectorBits: [bits(exports.minEfVecB()), bits(exports.minEfVecP()), bits(exports.minEfVecY())],
    expectedCostBits: bits(exports.minEfExpectedCost()),
  };
}

function isSolverExports(exports: WebAssembly.Exports): exports is SolverExports {
  return (
    exports["memory"] instanceof WebAssembly.Memory &&
    typeof exports["configureMinEfMemo"] === "function" &&
    typeof exports["getSolveStatus"] === "function" &&
    typeof exports["minEfAction"] === "function" &&
    typeof exports["minEfExpectedCost"] === "function" &&
    typeof exports["minEfMaxSuccessProb"] === "function" &&
    typeof exports["minEfNodeCount"] === "function" &&
    typeof exports["minEfSuccessProb"] === "function" &&
    typeof exports["minEfVecB"] === "function" &&
    typeof exports["minEfVecP"] === "function" &&
    typeof exports["minEfVecY"] === "function" &&
    typeof exports["solveMinEf"] === "function"
  );
}

function requireSolverExports(exports: WebAssembly.Exports): SolverExports {
  if (!isSolverExports(exports)) {
    throw new Error("Required min-E[f] WASM exports are missing.");
  }
  return exports;
}

function isCandidateExports(exports: SolverExports): exports is CandidateExports {
  return (
    typeof exports["configureMinEfBranchBoundPruning"] === "function" &&
    typeof exports["configureMinEfBranchBoundSuccessMemo"] === "function"
  );
}

function requireCandidateExports(exports: WebAssembly.Exports): CandidateExports {
  const solver = requireSolverExports(exports);
  if (!isCandidateExports(solver)) {
    throw new Error("Required branch-bound candidate exports are missing.");
  }
  return solver;
}

function buildOrder(repeat: number): readonly Build[] {
  return repeat % 4 === 0 || repeat % 4 === 3 ? ["product", "candidate"] : ["candidate", "product"];
}

function hasSample(samples: Sample[], repeat: number, build: Build, scenarioId: string): boolean {
  return samples.some(
    (sample) =>
      sample.repeat === repeat && sample.build === build && sample.scenarioId === scenarioId,
  );
}

function selectSamples(samples: Sample[], build: Build, scenarioId: string): Sample[] {
  return samples
    .filter((sample) => sample.build === build && sample.scenarioId === scenarioId)
    .sort((left, right) => left.repeat - right.repeat);
}

function semanticSet(samples: Sample[]): Set<string> {
  return new Set(samples.map((sample) => JSON.stringify(sample.semantic)));
}

function summarize(samples: Sample[]) {
  const values = samples.map((sample) => sample.elapsedMs);
  return {
    count: values.length,
    samplesMs: values,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    nodeCounts: [...new Set(samples.map((sample) => sample.nodeCount))],
    memoryGrowthMaxBytes: Math.max(...samples.map((sample) => sample.memoryGrowthBytes)),
  };
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) throw new Error("Cannot summarize an empty sample set.");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  const value = sorted[index];
  if (value === undefined) throw new Error("Percentile index was outside the sample set.");
  return value;
}

function bits(value: number): string {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  return `0x${view.getBigUint64(0, false).toString(16).padStart(16, "0")}`;
}

async function readCheckpoint(provenance: ResearchProvenance): Promise<Checkpoint | null> {
  const checkpoint = await readJson<Checkpoint>(CHECKPOINT_URL);
  if (!checkpoint) return null;
  if (!sameResearchIdentity(checkpoint.provenance, provenance)) {
    throw new Error("Existing latency checkpoint belongs to a different research contract.");
  }
  return checkpoint;
}

async function writeCheckpoint(provenance: ResearchProvenance, samples: Sample[]) {
  const checkpoint: Checkpoint = {
    kind: "min-ef-branch-bound-b2-latency-checkpoint",
    version: 1,
    provenance,
    samples,
  };
  await writeFile(CHECKPOINT_URL, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

async function readJson<T>(url: URL): Promise<T | null> {
  try {
    return JSON.parse(await readFile(url, "utf8")) as T;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

const mode = process.argv[2];
if (mode === "--child") {
  const build = process.argv[3];
  const scenarioId = process.argv[4];
  const wasmPath = process.argv[5];
  const repeat = Number(process.argv[6]);
  if (build !== "product" && build !== "candidate") throw new Error("Invalid child build.");
  const scenario = SCENARIOS.find((entry) => entry.id === scenarioId);
  if (!scenario || !wasmPath || !Number.isInteger(repeat)) throw new Error("Invalid child args.");
  await runChildProcess(build, scenario, wasmPath, repeat);
} else {
  await runParent();
}
