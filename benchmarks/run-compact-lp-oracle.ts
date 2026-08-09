import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

import { exportMaximumReachabilityMps } from "./compact-lp-oracle.ts";
import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  readOptionalResearchReport,
} from "./research-provenance.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(REPO_ROOT, "benchmarks/results/compact-lp-oracle-v1.json");
const MPS_OUTPUT = resolve(REPO_ROOT, "benchmarks/results/compact-lp-oracle-v1.mps");
const CONTRACT = {
  kind: "compact-lp-oracle",
  version: 1,
  objective: "maximum_reachability",
  scenario: "SR14e2900-balanced10",
  maximumStates: 100_000,
} as const;

const vite = await createServer({
  root: REPO_ROOT,
  logLevel: "error",
  server: { hmr: false, middlewareMode: true },
});
const compactModule = (await vite.ssrLoadModule("/benchmarks/compact-exact-graph.ts")) as {
  buildCompactStateGraph: typeof import("./compact-exact-graph").buildCompactStateGraph;
};
const { buildCompactStateGraph } = compactModule;
const built = buildCompactStateGraph(
  { grade: "SR", level: 14, exp: 2900 },
  { blue: 10, purple: 10, yellow: 10 },
  { stateBudget: CONTRACT.maximumStates },
);
await vite.close();
if (built.outcome !== "completed") throw new Error("Compact LP fixture exceeded its graph budget.");
const model = exportMaximumReachabilityMps(built.graph);
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(MPS_OUTPUT, model.text);

const { HIGHS_PATH: highsPath } = process.env;
let solver: {
  outcome: "completed" | "verification_incomplete" | "failure";
  version?: string;
  output?: string;
};
if (!highsPath) {
  solver = { outcome: "verification_incomplete", output: "HIGHS_PATH is not configured." };
} else {
  try {
    const version = execFileSync(highsPath, ["--version"], { encoding: "utf8" }).trim();
    const output = execFileSync(highsPath, [MPS_OUTPUT], { encoding: "utf8" });
    solver = { outcome: "completed", version, output: output.slice(-4_000) };
  } catch (error) {
    solver = { outcome: "failure", output: error instanceof Error ? error.message : String(error) };
  }
}

const provenance = collectResearchProvenance({
  repoRoot: REPO_ROOT,
  studyId: "compact-lp-oracle",
  protocolVersion: 1,
  contract: CONTRACT,
  sourceFiles: [
    "benchmarks/compact-exact-graph.ts",
    "benchmarks/compact-lp-oracle.ts",
    "benchmarks/run-compact-lp-oracle.ts",
  ],
});
const existing = readOptionalResearchReport(OUTPUT);
assertResearchReportCanBeWritten(existing, provenance);
writeFileSync(
  OUTPUT,
  `${JSON.stringify({ kind: CONTRACT.kind, version: CONTRACT.version, provenance, contract: CONTRACT, graph: { states: built.graph.nodes.length, edges: built.graph.edgeCount }, model: { variables: model.variables, flowRows: model.flowRows }, solver }, null, 2)}\n`,
);
console.log(
  JSON.stringify({ output: OUTPUT, solver: solver.outcome, states: built.graph.nodes.length }),
);
