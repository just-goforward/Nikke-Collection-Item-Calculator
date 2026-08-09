import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { createServer } from "vite";
import {
  createLatencyMeasurementProtocol,
  summarizeLatencySamples,
} from "../benchmarks/latency-report.ts";
import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  readOptionalResearchReport,
} from "../benchmarks/research-provenance.ts";
// The module is a browser entry loaded by frontier.html; this type-only edge keeps it in the source graph.
import type {} from "../benchmarks/webgpu/frontier-page.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(REPO_ROOT, "benchmarks/results/webgpu-compact-frontier-v1.json");
const CONTRACT = {
  kind: "webgpu-compact-frontier",
  version: 1,
  scenario: "SR10e2900-balanced30",
  repeats: 5,
  discardColdSamples: 1,
  quantile: 0.95,
  estimator: "nearest_rank_ceil",
  gpuAuthority: "integer_frontier_only",
  finalValueAuthority: "cpu_rust_f64",
} as const;

const server = await createServer({
  root: REPO_ROOT,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
const compactModule = (await server.ssrLoadModule("/benchmarks/compact-exact-graph.ts")) as {
  buildCompactStateGraph: typeof import("../benchmarks/compact-exact-graph").buildCompactStateGraph;
  expandFrontierKeysCpu: typeof import("../benchmarks/compact-exact-graph").expandFrontierKeysCpu;
  stateStockKey: typeof import("../benchmarks/compact-exact-graph").stateStockKey;
};
const { buildCompactStateGraph, expandFrontierKeysCpu, stateStockKey } = compactModule;
const built = buildCompactStateGraph(
  { grade: "SR", level: 10, exp: 2900 },
  { blue: 30, purple: 30, yellow: 30 },
  { stateBudget: 250_000 },
);
if (built.outcome !== "completed")
  throw new Error("WebGPU frontier fixture exceeded its CPU graph budget.");
const layers = new Map<number, number[]>();
for (const node of built.graph.nodes) {
  if (node.edges.length === 0) continue;
  const layer = layers.get(node.stockTotal) ?? [];
  layer.push(node.key);
  layers.set(node.stockTotal, layer);
}
const selectedLayer = [...layers.entries()].sort(
  (left, right) => right[1].length - left[1].length || right[0] - left[0],
)[0];
if (!selectedLayer) throw new Error("WebGPU frontier fixture has no expandable layer.");
const [stockTotal, inputKeys] = selectedLayer;
inputKeys.sort((left, right) => left - right);
const expectedKeys = expandFrontierKeysCpu(inputKeys);

await server.listen();
const baseUrl = server.resolvedUrls?.local[0];
if (!baseUrl) throw new Error("Vite did not expose a local WebGPU research URL.");

let browserVersion = "unknown";
let measurement:
  | {
      outcome: "completed";
      exactSetMatch: boolean;
      metadata: unknown;
      setupMs: number;
      latency: ReturnType<typeof summarizeLatencySamples>;
      outputKeys: number;
      capacityCensus: {
        elapsedMs: number;
        layers: number;
        maxFrontier: number;
        metadata: unknown;
        outcome: "completed" | "budget_exceeded";
        states: number;
      };
    }
  | { outcome: "device_unavailable" | "device_lost" | "failure"; error: string };
try {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: process.env["WEBGPU_HEADLESS"] === "1",
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
  });
  try {
    browserVersion = browser.version();
    const page = await browser.newPage();
    await page.goto(new URL("benchmarks/webgpu/frontier.html", baseUrl).toString());
    const result = await page.evaluate(
      async ({ keys, repeats }) => window.runCompactFrontierGpu({ keys, repeats }),
      { keys: inputKeys, repeats: CONTRACT.repeats },
    );
    const exactSetMatch = JSON.stringify(result.keys) === JSON.stringify(expectedKeys);
    const capacityCensus = await page.evaluate(
      async ({ maxLayers, maxStates, rootKey }) =>
        window.runCompactFrontierCensusGpu({ maxLayers, maxStates, rootKey }),
      {
        maxLayers: 91,
        maxStates: 1_200_000,
        rootKey: stateStockKey(
          { grade: "R", level: 10, exp: 0 },
          { blue: 30, purple: 30, yellow: 30 },
        ),
      },
    );
    measurement = {
      outcome: "completed",
      exactSetMatch,
      metadata: result.metadata,
      setupMs: result.setupMs,
      latency: summarizeLatencySamples(
        result.samplesMs,
        createLatencyMeasurementProtocol(CONTRACT.repeats),
      ),
      outputKeys: result.keys.length,
      capacityCensus,
    };
    if (!exactSetMatch) process.exitCode = 1;
  } finally {
    await browser.close();
  }
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  measurement = {
    outcome: message.includes("device_lost")
      ? "device_lost"
      : message.includes("device_unavailable")
        ? "device_unavailable"
        : "failure",
    error: message,
  };
} finally {
  await server.close();
}

const provenance = collectResearchProvenance({
  repoRoot: REPO_ROOT,
  studyId: "webgpu-compact-frontier",
  protocolVersion: 1,
  contract: CONTRACT,
  sourceFiles: [
    "benchmarks/compact-exact-graph.ts",
    "benchmarks/webgpu/compact-frontier-kernel.ts",
    "benchmarks/webgpu/frontier-page.ts",
    "scripts/run-webgpu-frontier-study.ts",
  ],
});
const existing = readOptionalResearchReport(OUTPUT);
assertResearchReportCanBeWritten(existing, provenance);
const report = {
  kind: CONTRACT.kind,
  version: CONTRACT.version,
  provenance,
  contract: CONTRACT,
  browserVersion,
  graph: {
    states: built.graph.nodes.length,
    edges: built.graph.edgeCount,
    selectedLayerStockTotal: stockTotal,
    inputKeys: inputKeys.length,
    expectedOutputKeys: expectedKeys.length,
  },
  measurement,
  adoption: {
    grade:
      measurement.outcome === "completed" && measurement.exactSetMatch
        ? "verification_incomplete"
        : "rejected",
    reason:
      measurement.outcome === "completed" && measurement.exactSetMatch
        ? "Frontier parity passed; full exact-value and product latency gates remain."
        : "WebGPU frontier parity or device availability failed.",
  },
};
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
