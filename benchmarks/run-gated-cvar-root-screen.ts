import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";

import type { RustCoreExports } from "../src/wasm/rustTypes";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const OUTPUT_FILE = new URL("./results/gated-cvar-root-screen.json", import.meta.url);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);

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
  const result = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  const instance = result instanceof WebAssembly.Instance ? result : result.instance;
  const exports = loader.rustCoreExportsFromInstance(instance) as RustCoreExports;
  const records = [];
  for (const scenario of scenarios) {
    const policy = policyModule.createGatedCvarPolicySolver(exports);
    const startedAt = performance.now();
    const root = policy.solve({ start: scenario.start, stock: scenario.stock, strategy: "supply" });
    const elapsedMs = performance.now() - startedAt;
    const decision = policy.decisions.at(-1);
    if (!decision) throw new Error(`Missing gated CVaR decision for ${scenario.id}.`);
    records.push({ decision, elapsedMs, root, scenario });
    console.log(
      `${scenario.id}: ${decision.selectedPolicy} ${decision.baselineAction ?? "none"}->${decision.firstAction ?? "none"}`,
    );
  }
  await writeFile(
    OUTPUT_FILE,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        kind: "gated-cvar-root-screen",
        options: {
          alpha: 0.9,
          etas: [0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6],
        },
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
