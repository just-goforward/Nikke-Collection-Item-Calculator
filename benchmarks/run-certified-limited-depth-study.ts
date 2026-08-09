import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  readOptionalResearchReport,
} from "./research-provenance.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(REPO_ROOT, "benchmarks/results/certified-limited-depth-v1.json");
const CONTRACT = {
  kind: "certified-limited-depth",
  version: 1,
  depths: [1, 2, 4, 8],
  stateBudget: 1_200_000,
  horizonFactor: 0.75,
  normPower: 3,
  tolerance: 0,
  scenarios: ["SR14e2900-balanced10", "R10-balanced300", "SR0-balanced300"],
} as const;

const vite = await createServer({
  root: REPO_ROOT,
  logLevel: "error",
  server: { hmr: false, middlewareMode: true },
});
const module = (await vite.ssrLoadModule("/benchmarks/certified-limited-depth.ts")) as {
  solveCertifiedLimitedDepth: typeof import("./certified-limited-depth").solveCertifiedLimitedDepth;
};
const scenarios = [
  {
    id: "SR14e2900-balanced10",
    start: { grade: "SR" as const, level: 14, exp: 2900 },
    stock: { blue: 10, purple: 10, yellow: 10 },
  },
  {
    id: "R10-balanced300",
    start: { grade: "R" as const, level: 10, exp: 0 },
    stock: { blue: 300, purple: 300, yellow: 300 },
  },
  {
    id: "SR0-balanced300",
    start: { grade: "SR" as const, level: 0, exp: 0 },
    stock: { blue: 300, purple: 300, yellow: 300 },
  },
];
const records = [];
for (const scenario of scenarios) {
  for (const depthLimit of CONTRACT.depths) {
    const startedAt = performance.now();
    const result = module.solveCertifiedLimitedDepth({
      start: scenario.start,
      stock: scenario.stock,
      depthLimit,
      stateBudget: CONTRACT.stateBudget,
      horizonFactor: CONTRACT.horizonFactor,
      normPower: CONTRACT.normPower,
      tolerance: CONTRACT.tolerance,
    });
    records.push({
      scenario: scenario.id,
      elapsedMs: performance.now() - startedAt,
      ...result,
    });
  }
}
await vite.close();

const provenance = collectResearchProvenance({
  repoRoot: REPO_ROOT,
  studyId: "certified-limited-depth",
  protocolVersion: 1,
  contract: CONTRACT,
  sourceFiles: [
    "benchmarks/compact-exact-graph.ts",
    "benchmarks/certified-limited-depth.ts",
    "benchmarks/run-certified-limited-depth-study.ts",
  ],
});
const existing = readOptionalResearchReport(OUTPUT);
assertResearchReportCanBeWritten(existing, provenance);
const target = records.filter((record) => record.scenario === "R10-balanced300");
const report = {
  kind: CONTRACT.kind,
  version: CONTRACT.version,
  provenance,
  contract: CONTRACT,
  records,
  adoption: {
    grade: target.some((record) => record.outcome === "completed")
      ? "verification_incomplete"
      : "rejected",
    reason: target.some((record) => record.outcome === "completed")
      ? "A root action was certified; exact interactive and latency gates remain."
      : "No pre-registered depth certified the R10 fallback root action.",
  },
};
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      output: OUTPUT,
      adoption: report.adoption,
      summary: records.map(({ scenario, depthLimit, outcome, expandedStates, elapsedMs }) => ({
        scenario,
        depthLimit,
        outcome,
        expandedStates,
        elapsedMs,
      })),
    },
    null,
    2,
  ),
);
