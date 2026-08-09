import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type BuildName = "base" | "candidate";
type Outcome = "completed" | "memo_full" | "budget_exceeded" | "failure";
type SolvePhase = "instance_cold_solve" | "allocation_warm_solve";
type MinEfExports = {
  configureMinEfMemo?: (tier: number) => void;
  configureNodeBudget?: (budget: number) => void;
  getSolveStatus?: () => number;
  memory?: WebAssembly.Memory;
  minEfNodeCount?: () => number;
  solveMinEf?: (
    stateId: number,
    bluePieces: number,
    purplePieces: number,
    yellowPieces: number,
    horizonFactor: number,
    normPower: number,
    tolerance: number,
  ) => void;
};
type Stock = readonly [blue: number, purple: number, yellow: number];
type Scenario = {
  id: string;
  measured: Stock;
  preparation: Stock;
  stateId: number;
};
type SolveRecord = {
  elapsedMs: number;
  failureMs?: number;
  memoryAfter: number;
  memoryBefore: number;
  nodeCount: number | null;
  outcome: Outcome;
  phase: SolvePhase;
  scenario: string;
};
type ChildSample = {
  instantiateMs: number;
  records: SolveRecord[];
};
type BuildSample = ChildSample & {
  build: BuildName;
  repeat: number;
};
type CompileSample = {
  build: BuildName;
  elapsedMs: number;
  repeat: number;
};

const PROFILE = "minef-terminal-cache-v1";
const REPEATS = 31;
const WARM_RATIO_TARGET = 0.97;
const COLD_PERCENT_LIMIT = 0.05;
const COLD_ABSOLUTE_LIMIT_MS = 2;
const PHASE_PERCENT_LIMIT = 0.1;
const PHASE_ABSOLUTE_LIMIT_MS = 5;
const MIN_EF_MEMO_TIER = 21;
const MIN_EF_NODE_BUDGET = 2_000_000;
const selfPath = fileURLToPath(import.meta.url);

const scenarios: Scenario[] = [
  {
    id: "R0-remainder-denominators",
    measured: [61, 121, 901],
    preparation: [60, 120, 900],
    stateId: 0,
  },
  {
    id: "SR5-balanced",
    measured: [301, 301, 301],
    preparation: [300, 300, 300],
    stateId: (16 + 5) * 30,
  },
];

function requiredPath(name: "WASM_BASE_PATH" | "WASM_CANDIDATE_PATH") {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return resolve(value);
}

function configuredRepeats() {
  const value = Number(process.env["WASM_BENCH_REPEATS"]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : REPEATS;
}

function quantile(values: number[], q: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? null;
}

function median(values: number[]) {
  return quantile(values, 0.5);
}

function outcomeFromStatus(status: number): Outcome {
  if (status === 0) return "completed";
  if (status === 1) return "budget_exceeded";
  if (status === 2) return "memo_full";
  return "failure";
}

function requireFunction<T extends (...args: never[]) => unknown>(
  value: T | undefined,
  name: string,
): T {
  if (typeof value !== "function") throw new Error(`WASM export ${name} is missing.`);
  return value;
}

async function compileModule(path: string) {
  return WebAssembly.compile(await readFile(path));
}

async function instantiateMinEf(module: WebAssembly.Module) {
  const startedAt = performance.now();
  const instance = await WebAssembly.instantiate(module);
  const elapsedMs = performance.now() - startedAt;
  const exports = instance.exports as MinEfExports;
  requireFunction(exports.configureMinEfMemo, "configureMinEfMemo")(MIN_EF_MEMO_TIER);
  exports.configureNodeBudget?.(MIN_EF_NODE_BUDGET);
  requireFunction(exports.solveMinEf, "solveMinEf");
  requireFunction(exports.getSolveStatus, "getSolveStatus");
  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("WASM export memory is missing.");
  }
  return { elapsedMs, exports };
}

function runSolve(exports: MinEfExports, stateId: number, stock: Stock) {
  const solveMinEf = requireFunction(exports.solveMinEf, "solveMinEf");
  solveMinEf(stateId, stock[0], stock[1], stock[2], 0.75, 3, 0);
  const status = requireFunction(exports.getSolveStatus, "getSolveStatus")();
  return {
    nodeCount: exports.minEfNodeCount?.() ?? null,
    outcome: outcomeFromStatus(status),
  };
}

async function measureScenario(
  module: WebAssembly.Module,
  scenario: Scenario,
  phase: SolvePhase,
): Promise<{ instantiateMs: number; record: SolveRecord }> {
  const { elapsedMs: instantiateMs, exports } = await instantiateMinEf(module);
  if (phase === "allocation_warm_solve") {
    const preparation = runSolve(exports, scenario.stateId, scenario.preparation);
    if (preparation.outcome !== "completed") {
      throw new Error(
        `${scenario.id} preparation returned ${preparation.outcome}; warm measurement is invalid.`,
      );
    }
  }

  const memoryBefore = exports.memory?.buffer.byteLength ?? 0;
  const startedAt = performance.now();
  const result = runSolve(exports, scenario.stateId, scenario.measured);
  const elapsedMs = performance.now() - startedAt;
  const memoryAfter = exports.memory?.buffer.byteLength ?? 0;
  return {
    instantiateMs,
    record: {
      elapsedMs,
      ...(result.outcome === "completed" ? {} : { failureMs: elapsedMs }),
      memoryAfter,
      memoryBefore,
      nodeCount: result.nodeCount,
      outcome: result.outcome,
      phase,
      scenario: scenario.id,
    },
  };
}

async function runSolveChild(path: string) {
  const module = await compileModule(path);
  const records: SolveRecord[] = [];
  let instantiateMs = 0;
  for (const scenario of scenarios) {
    for (const phase of ["instance_cold_solve", "allocation_warm_solve"] as const) {
      const sample = await measureScenario(module, scenario, phase);
      instantiateMs += sample.instantiateMs;
      records.push(sample.record);
    }
  }
  emit({ instantiateMs: instantiateMs / (scenarios.length * 2), records } satisfies ChildSample);
}

async function runCompileChild(path: string) {
  const bytes = await readFile(path);
  const startedAt = performance.now();
  await WebAssembly.compile(bytes);
  emit({ elapsedMs: performance.now() - startedAt });
}

function emit(value: unknown) {
  process.stdout.write(`WASM_CANDIDATE_SAMPLE:${JSON.stringify(value)}\n`);
}

function readChild<T>(args: string[]): T {
  const result = spawnSync(process.execPath, [selfPath, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`WASM candidate benchmark child failed:\n${result.stderr || result.stdout}`);
  }
  const line = result.stdout
    .split(/\r?\n/)
    .reverse()
    .find((entry) => entry.startsWith("WASM_CANDIDATE_SAMPLE:"));
  if (!line)
    throw new Error(`WASM candidate benchmark child returned no sample:\n${result.stdout}`);
  return JSON.parse(line.slice("WASM_CANDIDATE_SAMPLE:".length)) as T;
}

function buildOrder(repeat: number): readonly BuildName[] {
  return repeat % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"];
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function recordsFor(samples: BuildSample[], build: BuildName, scenario: string, phase: SolvePhase) {
  return samples
    .filter((sample) => sample.build === build)
    .flatMap((sample) => sample.records)
    .filter((record) => record.scenario === scenario && record.phase === phase);
}

function summarize(samples: BuildSample[]) {
  return Object.fromEntries(
    scenarios.flatMap((scenario) =>
      (["instance_cold_solve", "allocation_warm_solve"] as const).map((phase) => {
        const base = recordsFor(samples, "base", scenario.id, phase);
        const candidate = recordsFor(samples, "candidate", scenario.id, phase);
        const outcomes = {
          base: [...new Set(base.map((record) => record.outcome))],
          candidate: [...new Set(candidate.map((record) => record.outcome))],
        };
        const pairedRatios = samples.flatMap((sample) => {
          if (sample.build !== "base") return [];
          const baseRecord = sample.records.find(
            (record) => record.scenario === scenario.id && record.phase === phase,
          );
          const candidateRecord = samples
            .find((entry) => entry.repeat === sample.repeat && entry.build === "candidate")
            ?.records.find((record) => record.scenario === scenario.id && record.phase === phase);
          if (
            !baseRecord ||
            !candidateRecord ||
            baseRecord.outcome !== "completed" ||
            candidateRecord.outcome !== "completed"
          ) {
            return [];
          }
          return [candidateRecord.elapsedMs / baseRecord.elapsedMs];
        });
        return [
          `${scenario.id}:${phase}`,
          {
            outcomes,
            base: {
              memoryGrowthMax: Math.max(
                ...base.map((record) => record.memoryAfter - record.memoryBefore),
              ),
              p50Ms: median(base.map((record) => record.elapsedMs)),
              p95Ms: quantile(
                base.map((record) => record.elapsedMs),
                0.95,
              ),
            },
            candidate: {
              memoryGrowthMax: Math.max(
                ...candidate.map((record) => record.memoryAfter - record.memoryBefore),
              ),
              p50Ms: median(candidate.map((record) => record.elapsedMs)),
              p95Ms: quantile(
                candidate.map((record) => record.elapsedMs),
                0.95,
              ),
            },
            pairedMedianRatio: median(pairedRatios),
          },
        ];
      }),
    ),
  );
}

type SummaryEntry = NonNullable<ReturnType<typeof summarize>[string]>;

function outcomesRemainCompleted(entry: SummaryEntry) {
  return (
    entry.outcomes.base.length === 1 &&
    entry.outcomes.candidate.length === 1 &&
    entry.outcomes.base[0] === "completed" &&
    entry.outcomes.candidate[0] === "completed"
  );
}

function exceedsLimit(
  base: number | null,
  candidate: number | null,
  percent: number,
  absoluteMs: number,
) {
  return (
    base !== null && candidate !== null && candidate > base + Math.max(absoluteMs, base * percent)
  );
}

function solveGateBlockers(label: string, phase: SolvePhase, entry: SummaryEntry) {
  if (!outcomesRemainCompleted(entry)) {
    return [`${label} did not remain completed in both builds`];
  }
  const blockers: string[] = [];
  if (
    phase === "allocation_warm_solve" &&
    (entry.pairedMedianRatio === null || entry.pairedMedianRatio > WARM_RATIO_TARGET)
  ) {
    blockers.push(
      `${label} paired median ratio ${entry.pairedMedianRatio ?? "missing"} exceeds ${WARM_RATIO_TARGET}`,
    );
  }
  if (
    phase === "instance_cold_solve" &&
    exceedsLimit(
      entry.base.p50Ms,
      entry.candidate.p50Ms,
      COLD_PERCENT_LIMIT,
      COLD_ABSOLUTE_LIMIT_MS,
    )
  ) {
    blockers.push(`${label} exceeded the cold non-regression limit`);
  }
  return blockers;
}

function gate(
  summary: ReturnType<typeof summarize>,
  compile: { base: number | null; candidate: number | null },
  instantiate: { base: number | null; candidate: number | null },
) {
  const blockers = scenarios.flatMap((scenario) =>
    (["instance_cold_solve", "allocation_warm_solve"] as const).flatMap((phase) => {
      const label = `${scenario.id}:${phase}`;
      const entry = summary[label];
      return entry ? solveGateBlockers(label, phase, entry) : [];
    }),
  );
  for (const [phase, values] of [
    ["compile", compile],
    ["instantiate", instantiate],
  ] as const) {
    if (exceedsLimit(values.base, values.candidate, PHASE_PERCENT_LIMIT, PHASE_ABSOLUTE_LIMIT_MS)) {
      blockers.push(`${phase} exceeded the gross regression limit`);
    }
  }
  return blockers;
}

async function runParent() {
  if (process.env["WASM_BENCH_PROFILE"] !== PROFILE) {
    throw new Error(`WASM_BENCH_PROFILE must be ${PROFILE}.`);
  }
  const paths = {
    base: requiredPath("WASM_BASE_PATH"),
    candidate: requiredPath("WASM_CANDIDATE_PATH"),
  } as const;
  const [baseHash, candidateHash] = await Promise.all([
    sha256(paths.base),
    sha256(paths.candidate),
  ]);
  if (baseHash === candidateHash) throw new Error("Base and candidate WASM hashes are identical.");

  const repeats = configuredRepeats();
  const compileSamples: CompileSample[] = [];
  const solveSamples: BuildSample[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const build of buildOrder(repeat)) {
      const compile = readChild<{ elapsedMs: number }>(["--compile-child", paths[build]]);
      compileSamples.push({ build, elapsedMs: compile.elapsedMs, repeat });
      solveSamples.push({
        ...readChild<ChildSample>(["--solve-child", paths[build]]),
        build,
        repeat,
      });
    }
  }

  const phaseMedian = (build: BuildName, select: (sample: BuildSample) => number) =>
    median(solveSamples.filter((sample) => sample.build === build).map(select));
  const compileMedian = (build: BuildName) =>
    median(
      compileSamples.filter((sample) => sample.build === build).map((sample) => sample.elapsedMs),
    );
  const compile = { base: compileMedian("base"), candidate: compileMedian("candidate") };
  const instantiate = {
    base: phaseMedian("base", (sample) => sample.instantiateMs),
    candidate: phaseMedian("candidate", (sample) => sample.instantiateMs),
  };
  const summary = summarize(solveSamples);
  const blockers = gate(summary, compile, instantiate);
  const [baseStat, candidateStat] = await Promise.all([stat(paths.base), stat(paths.candidate)]);
  const report = {
    generatedAt: new Date().toISOString(),
    profile: PROFILE,
    gitCommit: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    runtime: {
      arch: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      node: process.version,
      os: `${platform()} ${release()}`,
      rustc: spawnSync("rustc", ["--version"], { encoding: "utf8" }).stdout.trim(),
    },
    repeats,
    builds: {
      base: { bytes: baseStat.size, path: paths.base, sha256: baseHash },
      candidate: { bytes: candidateStat.size, path: paths.candidate, sha256: candidateHash },
    },
    phases: { compile, instantiate },
    scenarios: summary,
    gate: { blockers, passed: blockers.length === 0 },
    limitations: [
      "memory.buffer.byteLength is a page-growth signal, not logical allocation size",
      "failure latency does not measure recovery-policy frequency or classifier accuracy",
      "browser and physical-device measurements are separate adoption gates",
    ],
  };
  const outputPath = process.env["WASM_BENCH_OUTPUT"];
  if (outputPath) await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (blockers.length > 0) process.exitCode = 1;
}

const mode = process.argv[2];
if (mode === "--compile-child") {
  const path = process.argv[3];
  if (!path) throw new Error("Missing compile child WASM path.");
  await runCompileChild(path);
} else if (mode === "--solve-child") {
  const path = process.argv[3];
  if (!path) throw new Error("Missing solve child WASM path.");
  await runSolveChild(path);
} else {
  await runParent();
}
