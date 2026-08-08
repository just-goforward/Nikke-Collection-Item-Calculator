import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";

import type { RustCoreExports } from "../src/wasm/rustTypes";
import { envValue, parseList, parsePositiveInteger } from "./runner-utils.ts";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const OUTPUT_FILE = new URL("./results/gated-cvar-study.json", import.meta.url);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);
const DEFAULT_SCENARIOS = ["R14e900-yellow30"] as const;

const scenarioIds = parseList(envValue("GATED_CVAR_SCENARIOS"), DEFAULT_SCENARIOS);
const timeBudgetMs = parsePositiveInteger(envValue("GATED_CVAR_TIME_BUDGET_MS"), 120_000);
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
  const evaluator = (await server.ssrLoadModule(
    "/benchmarks/evaluator/exact-replan.ts",
  )) as typeof import("./evaluator/exact-replan");
  const policyModule = (await server.ssrLoadModule(
    "/benchmarks/gated-cvar-policy.ts",
  )) as typeof import("./gated-cvar-policy");
  const loader = (await server.ssrLoadModule(
    "/src/wasm/rustLoader.ts",
  )) as typeof import("../src/wasm/rustLoader");
  const fixed = (await server.ssrLoadModule(
    "/benchmarks/scenarios/fixed-grid.ts",
  )) as typeof import("./scenarios/fixed-grid");
  const product = (await server.ssrLoadModule(
    "/benchmarks/scenarios/rerank-product.ts",
  )) as typeof import("./scenarios/rerank-product");
  const supplemental = (await server.ssrLoadModule(
    "/benchmarks/scenarios/rerank-supplemental.ts",
  )) as typeof import("./scenarios/rerank-supplemental");
  const scenarios = [
    ...fixed.FIXED_SAFETY_GRID,
    ...product.PRODUCT_RERANK_SCENARIOS,
    ...supplemental.RERANK_SUPPLEMENTAL_SCENARIOS,
  ];
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const selected = scenarioIds.map((id) => {
    const scenario = byId.get(id);
    if (!scenario) throw new Error(`Unknown gated CVaR scenario: ${id}`);
    return scenario;
  });

  const records = [];
  for (const scenario of selected) {
    const result = (await WebAssembly.instantiate(wasm)) as
      | WebAssembly.Instance
      | { instance: WebAssembly.Instance };
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    const exports = loader.rustCoreExportsFromInstance(instance) as RustCoreExports;
    const candidatePolicy = policyModule.createGatedCvarPolicySolver(exports);
    const baseline = evaluator.evaluateExactInteractiveReplan(scenario, {
      modelId: "phase2",
      timeBudgetMs,
    });
    const candidate = evaluator.evaluateExactInteractiveReplan(scenario, {
      modelId: "gated-cvar-one-step-grid-v1",
      policySolver: candidatePolicy.solve,
      timeBudgetMs,
    });
    records.push({
      scenarioId: scenario.id,
      baseline,
      candidate,
      decisions: candidatePolicy.decisions,
    });
    console.log(
      `${scenario.id}: baseline=${baseline.status} candidate=${candidate.status} policyCalls=${candidatePolicy.decisions.length}`,
    );
  }

  const report = {
    kind: "gated-cvar-interactive-study",
    version: 1,
    generatedAt: new Date().toISOString(),
    options: {
      alpha: 0.9,
      etas: [0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6],
      scenarioIds,
      timeBudgetMs,
    },
    records,
  };
  await writeFile(OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUTPUT_FILE.pathname}`);
} finally {
  await server.close();
}
