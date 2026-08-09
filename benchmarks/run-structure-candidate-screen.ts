import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

import type { Kit } from "../src/types";
import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  readOptionalResearchReport,
} from "./research-provenance.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(REPO_ROOT, "benchmarks/results/structure-candidate-screen-v1.json");
const CONTRACT = {
  kind: "structure-candidate-screen",
  version: 1,
  compactScenario: "SR10e2900-balanced30",
  monotonicityStates: ["SR14e2900", "R14e900"],
  variedUses: { minimum: 0, maximum: 12, fixedOtherUses: 4 },
  stateBudget: 250_000,
  paretoVectorBudget: 2_000_000,
  paretoP95WidthLimit: 32,
  symbolicMinimumReduction: 0.3,
  exactRangeBlocker: "R10-balanced300 exceeded the pre-registered 1,200,000-state budget",
} as const;

type MonotonicityLineRecord =
  | { availableUses: number; outcome: "budget_exceeded" }
  | {
      availableUses: number;
      outcome: "completed";
      action: Kit | null;
      successProbability: number;
    };

const vite = await createServer({
  root: REPO_ROOT,
  logLevel: "error",
  server: { hmr: false, middlewareMode: true },
});
try {
  const compact = (await vite.ssrLoadModule(
    "/benchmarks/compact-exact-graph.ts",
  )) as typeof import("./compact-exact-graph");
  const pareto = (await vite.ssrLoadModule(
    "/benchmarks/pareto-frontier-dp.ts",
  )) as typeof import("./pareto-frontier-dp");
  const monotonicity = (await vite.ssrLoadModule(
    "/benchmarks/monotonicity-screen.ts",
  )) as typeof import("./monotonicity-screen");
  const symbolic = (await vite.ssrLoadModule(
    "/benchmarks/symbolic-compression-screen.ts",
  )) as typeof import("./symbolic-compression-screen");

  const built = compact.buildCompactStateGraph(
    { grade: "SR", level: 10, exp: 2900 },
    { blue: 30, purple: 30, yellow: 30 },
    { stateBudget: CONTRACT.stateBudget },
  );
  if (built.outcome !== "completed") {
    throw new Error("The compact structure fixture exceeded its registered graph budget.");
  }
  const solution = compact.solveCompactMinEf(built.graph);
  const paretoStartedAt = performance.now();
  const paretoResult = pareto.solveParetoFrontiers(built.graph, CONTRACT.paretoVectorBudget);
  const paretoElapsedMs = performance.now() - paretoStartedAt;
  const symbolicStartedAt = performance.now();
  const symbolicResult = symbolic.screenExactSymbolicCompression(built.graph, solution);
  const symbolicElapsedMs = performance.now() - symbolicStartedAt;

  const axes = ["blue", "purple", "yellow"] as const;
  const starts = [
    { id: "SR14e2900", state: { grade: "SR" as const, level: 14, exp: 2900 } },
    { id: "R14e900", state: { grade: "R" as const, level: 14, exp: 900 } },
  ];
  const monotonicityRecords = [];
  for (const start of starts) {
    for (const axis of axes) {
      const line: MonotonicityLineRecord[] = [];
      for (
        let availableUses = CONTRACT.variedUses.minimum;
        availableUses <= CONTRACT.variedUses.maximum;
        availableUses += 1
      ) {
        const stockUses = {
          blue: CONTRACT.variedUses.fixedOtherUses,
          purple: CONTRACT.variedUses.fixedOtherUses,
          yellow: CONTRACT.variedUses.fixedOtherUses,
          [axis]: availableUses,
        };
        const stock = {
          blue: stockUses.blue * 10,
          purple: stockUses.purple * 10,
          yellow: stockUses.yellow * 10,
        };
        const lineGraph = compact.buildCompactStateGraph(start.state, stock, {
          stateBudget: CONTRACT.stateBudget,
        });
        if (lineGraph.outcome !== "completed") {
          line.push({ availableUses, outcome: lineGraph.outcome });
          continue;
        }
        const value = compact.solveCompactMinEf(lineGraph.graph).root;
        line.push({
          availableUses,
          outcome: "completed" as const,
          action: value.action,
          successProbability: value.successProbability,
        });
      }
      const completed = line.filter(
        (record): record is Extract<(typeof line)[number], { outcome: "completed" }> =>
          record.outcome === "completed",
      );
      monotonicityRecords.push({
        state: start.id,
        axis,
        records: line,
        successMonotone: monotonicity.successIsMonotone(completed),
        reentrantPatterns: monotonicity.findReentrantActionPatterns(completed),
      });
    }
  }

  const reentrantPatternCount = monotonicityRecords.reduce(
    (sum, record) => sum + record.reentrantPatterns.length,
    0,
  );
  const monotonicityViolationCount = monotonicityRecords.filter(
    (record) => !record.successMonotone,
  ).length;
  const paretoPassedScreen =
    paretoResult.outcome === "completed" && paretoResult.p95Width <= CONTRACT.paretoP95WidthLimit;
  const symbolicPassedScreen =
    symbolicResult.exactValueMismatches === 0 &&
    symbolicResult.reduction >= CONTRACT.symbolicMinimumReduction;
  const reportBody = {
    compactGraph: {
      states: built.graph.nodes.length,
      edges: built.graph.edgeCount,
      maxLayerWidth: built.graph.maxLayerWidth,
      rootAction: solution.root.action,
    },
    pareto: {
      elapsedMs: paretoElapsedMs,
      result: paretoResult,
      adoption: {
        grade: paretoPassedScreen ? "verification_incomplete" : "rejected",
        reason: paretoPassedScreen
          ? `Small-fixture width passed, but ${CONTRACT.exactRangeBlocker}.`
          : "The small-fixture Pareto width or vector budget gate failed.",
      },
    },
    monotonicity: {
      records: monotonicityRecords,
      reentrantPatternCount,
      monotonicityViolationCount,
      adoption: {
        grade:
          reentrantPatternCount > 0 || monotonicityViolationCount > 0
            ? "rejected"
            : "verification_incomplete",
        reason:
          reentrantPatternCount > 0
            ? "Sampled inventory lines contain re-entrant actions, refuting a simple threshold policy."
            : monotonicityViolationCount > 0
              ? "A sampled success-probability monotonicity check failed."
              : "No sampled counterexample is not a global monotonicity proof.",
      },
    },
    symbolic: {
      elapsedMs: symbolicElapsedMs,
      result: symbolicResult,
      adoption: {
        grade: symbolicPassedScreen ? "verification_incomplete" : "rejected",
        reason: symbolicPassedScreen
          ? `Exact small-fixture reduction passed, but ${CONTRACT.exactRangeBlocker}.`
          : "Exact structural partitioning did not reach the pre-registered reduction gate.",
      },
    },
  };

  const provenance = collectResearchProvenance({
    repoRoot: REPO_ROOT,
    studyId: CONTRACT.kind,
    protocolVersion: CONTRACT.version,
    contract: CONTRACT,
    sourceFiles: [
      "benchmarks/compact-exact-graph.ts",
      "benchmarks/pareto-frontier-dp.ts",
      "benchmarks/monotonicity-screen.ts",
      "benchmarks/symbolic-compression-screen.ts",
      "benchmarks/run-structure-candidate-screen.ts",
    ],
  });
  const existing = readOptionalResearchReport(OUTPUT);
  assertResearchReportCanBeWritten(existing, provenance);
  const report = {
    kind: CONTRACT.kind,
    version: CONTRACT.version,
    provenance,
    contract: CONTRACT,
    ...reportBody,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(report, mapResearchValue, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        output: OUTPUT,
        compactGraph: reportBody.compactGraph,
        pareto: reportBody.pareto.adoption,
        monotonicity: reportBody.monotonicity.adoption,
        symbolic: reportBody.symbolic.adoption,
      },
      null,
      2,
    ),
  );
} finally {
  await vite.close();
}

function mapResearchValue(_key: string, value: unknown): unknown {
  return value instanceof Map ? [...value.entries()] : value;
}
