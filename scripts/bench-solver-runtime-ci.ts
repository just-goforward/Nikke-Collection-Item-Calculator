import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { SolverInput } from "../src/types.ts";

type Backend = "rust-min-ef" | "rust-phase2" | "js-phase2";
type RuntimeRecord = {
  backend: Backend;
  scenario: string;
  repeat: number;
  elapsedMs: number;
  status: "completed" | "error";
  error?: string;
};

const DEFAULT_REPEATS = 2;
const REGRESSION_LIMIT = 1.2;
const wasmFile = new URL("../public/solver_rs.wasm", import.meta.url);

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
  const value = Number(process.env["SOLVER_RUNTIME_CI_REPEATS"]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_REPEATS;
}

async function wasmDataUrl() {
  const wasm = await readFile(wasmFile);
  return `data:application/wasm;base64,${Buffer.from(wasm).toString("base64")}`;
}

async function solveBackend(
  modules: {
    solver: typeof import("../src/solver/solve.ts");
    rustMinEf: typeof import("../src/wasm/rustMinEfSolver.ts");
    rustPhase2: typeof import("../src/wasm/rustPhase2ProductSolver.ts");
  },
  backend: Backend,
  input: SolverInput,
  wasmUrl: string,
) {
  if (backend === "rust-min-ef") return modules.rustMinEf.solveRustMinEf(input, wasmUrl);
  if (backend === "rust-phase2") return modules.rustPhase2.solveRustPhase2(input, wasmUrl);
  return modules.solver.solveWithResearchCostModel(
    input,
    { kind: "availability-pnorm", horizonFactor: 0.75, normPower: 3 },
    undefined,
    { toleranceOverride: 0 },
  );
}

function quantile(values: number[], q: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? null;
}

function summarize(records: RuntimeRecord[]) {
  const byBackend = new Map<Backend, RuntimeRecord[]>();
  for (const backend of ["rust-min-ef", "rust-phase2", "js-phase2"] as const) {
    byBackend.set(
      backend,
      records.filter((record) => record.backend === backend),
    );
  }
  return Object.fromEntries(
    [...byBackend].map(([backend, backendRecords]) => {
      const completed = backendRecords
        .filter((record) => record.status === "completed")
        .map((record) => record.elapsedMs);
      return [
        backend,
        {
          completed: completed.length,
          errors: backendRecords.length - completed.length,
          p50Ms: quantile(completed, 0.5),
          p95Ms: quantile(completed, 0.95),
          maxMs: completed.length > 0 ? Math.max(...completed) : null,
        },
      ];
    }),
  );
}

async function readBaseline() {
  const baselinePath = process.env["SOLVER_RUNTIME_BASELINE"];
  if (!baselinePath) return null;
  const text = await readFile(baselinePath, "utf8");
  return JSON.parse(text) as { summary?: Record<string, { p95Ms?: number | null }> };
}

function assertNoRegression(
  current: Record<string, { p95Ms?: number | null }>,
  baseline: { summary?: Record<string, { p95Ms?: number | null }> } | null,
) {
  if (!baseline?.summary) return [];
  const failures: string[] = [];
  for (const [backend, currentSummary] of Object.entries(current)) {
    const baselineP95 = baseline.summary[backend]?.p95Ms;
    const currentP95 = currentSummary.p95Ms;
    if (!baselineP95 || !currentP95) continue;
    if (currentP95 > baselineP95 * REGRESSION_LIMIT) {
      failures.push(
        `${backend} p95 ${currentP95.toFixed(2)}ms exceeds baseline ${baselineP95.toFixed(2)}ms by more than 20%`,
      );
    }
  }
  return failures;
}

const wasmUrl = await wasmDataUrl();
const records: RuntimeRecord[] = [];
const backendOrder = ["rust-min-ef", "rust-phase2", "js-phase2"] as const;
const warmupScenario = scenarios[0];
if (!warmupScenario) throw new Error("No solver runtime scenarios configured.");

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

try {
  const modules = {
    solver: (await server.ssrLoadModule(
      "/src/solver/solve.ts",
    )) as typeof import("../src/solver/solve.ts"),
    rustMinEf: (await server.ssrLoadModule(
      "/src/wasm/rustMinEfSolver.ts",
    )) as typeof import("../src/wasm/rustMinEfSolver.ts"),
    rustPhase2: (await server.ssrLoadModule(
      "/src/wasm/rustPhase2ProductSolver.ts",
    )) as typeof import("../src/wasm/rustPhase2ProductSolver.ts"),
  };

  for (const backend of backendOrder) {
    await solveBackend(modules, backend, warmupScenario.input, wasmUrl);
  }

  for (const scenario of scenarios) {
    for (const backend of backendOrder) {
      for (let repeat = 0; repeat < repeats(); repeat += 1) {
        const startedAt = performance.now();
        try {
          await solveBackend(modules, backend, scenario.input, wasmUrl);
          records.push({
            backend,
            scenario: scenario.id,
            repeat,
            elapsedMs: performance.now() - startedAt,
            status: "completed",
          });
        } catch (error) {
          records.push({
            backend,
            scenario: scenario.id,
            repeat,
            elapsedMs: performance.now() - startedAt,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
} finally {
  await server.close();
}

const summary = summarize(records) as Record<string, { p95Ms?: number | null }>;
const report = {
  generatedAt: new Date().toISOString(),
  repeats: repeats(),
  wasm: fileURLToPath(wasmFile),
  records,
  summary,
};
const failures = assertNoRegression(summary, await readBaseline());

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  throw new Error(`Solver runtime regression detected:\n${failures.join("\n")}`);
}
