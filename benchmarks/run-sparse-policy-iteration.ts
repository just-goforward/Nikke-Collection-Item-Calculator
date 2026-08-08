import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";

import type { RustCoreExports } from "../src/wasm/rustTypes";
import { envValue, parseList, parsePositiveInteger } from "./runner-utils.ts";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const OUTPUT_FILE = new URL("./results/sparse-policy-iteration.json", import.meta.url);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);
const DEFAULT_SCENARIOS = ["R14e900-yellow30", "R10-balanced300"] as const;

const scenarioIds = parseList(envValue("SPARSE_PI_SCENARIOS"), DEFAULT_SCENARIOS);
const maxStates = parsePositiveInteger(envValue("SPARSE_PI_MAX_STATES"), 1_200_000);
const maxIterations = parsePositiveInteger(envValue("SPARSE_PI_MAX_ITERATIONS"), 40);
const timeBudgetMs = parsePositiveInteger(envValue("SPARSE_PI_TIME_BUDGET_MS"), 300_000);
const wasm = await readFile(WASM_URL);
await mkdir(RESULTS_DIRECTORY, { recursive: true });
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
  const policy = (await server.ssrLoadModule(
    "/benchmarks/sparse-policy-iteration.ts",
  )) as typeof import("./sparse-policy-iteration");
  const fixed = (await server.ssrLoadModule(
    "/benchmarks/scenarios/fixed-grid.ts",
  )) as typeof import("./scenarios/fixed-grid");
  const product = (await server.ssrLoadModule(
    "/benchmarks/scenarios/rerank-product.ts",
  )) as typeof import("./scenarios/rerank-product");
  const supplemental = (await server.ssrLoadModule(
    "/benchmarks/scenarios/rerank-supplemental.ts",
  )) as typeof import("./scenarios/rerank-supplemental");
  const byId = new Map(
    [
      ...fixed.FIXED_SAFETY_GRID,
      ...product.PRODUCT_RERANK_SCENARIOS,
      ...supplemental.RERANK_SUPPLEMENTAL_SCENARIOS,
    ].map((scenario) => [scenario.id, scenario]),
  );

  const records = [];
  for (const scenarioId of scenarioIds) {
    const scenario = byId.get(scenarioId);
    if (!scenario) throw new Error(`Unknown sparse policy-iteration scenario: ${scenarioId}`);
    const result = (await WebAssembly.instantiate(wasm)) as
      | WebAssembly.Instance
      | { instance: WebAssembly.Instance };
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    const exports = loader.rustCoreExportsFromInstance(instance) as RustCoreExports;
    const record = policy.solveSparsePolicyIteration(
      exports,
      { start: scenario.start, stock: scenario.stock, strategy: "supply" },
      { maxIterations, maxStates, memoTier: 22, timeBudgetMs },
    );
    records.push({ scenarioId, ...record });
    console.log(
      `${scenarioId}: ${record.outcome} iterations=${record.iterations.length} cost=${record.finalValue?.cost ?? "n/a"}`,
    );
  }

  await writeFile(
    OUTPUT_FILE,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        kind: "sparse-constrained-policy-iteration",
        options: { maxIterations, maxStates, scenarioIds, timeBudgetMs, tolerance: 0 },
        records,
        version: 2,
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
