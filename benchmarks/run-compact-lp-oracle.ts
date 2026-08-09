import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

import type { CompactMinEfResult, CompactStateGraph } from "./compact-exact-graph.ts";
import type { CompactOccupancyMps, ParsedHighsSolution } from "./compact-lp-oracle.ts";
import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  readOptionalResearchReport,
} from "./research-provenance.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(REPO_ROOT, "benchmarks/results/compact-lp-oracle-v2.json");
const ARTIFACT_PREFIX = resolve(REPO_ROOT, "benchmarks/results/compact-lp-oracle-v2");
const LP_CONSTRAINT_TOLERANCE = 0;
const PARITY_TOLERANCE = 1e-8;
const CONTRACT = {
  kind: "compact-lp-oracle",
  version: 2,
  objective: "lexicographic_max_reachability_min_cost_min_total_uses",
  scenarios: [
    {
      id: "SR14e2900-balanced10",
      start: { grade: "SR" as const, level: 14, exp: 2900 },
      stock: { blue: 10, purple: 10, yellow: 10 },
    },
    {
      id: "SR10e2900-balanced30",
      start: { grade: "SR" as const, level: 10, exp: 2900 },
      stock: { blue: 30, purple: 30, yellow: 30 },
    },
    {
      id: "R14e900-balanced10",
      start: { grade: "R" as const, level: 14, exp: 900 },
      stock: { blue: 10, purple: 10, yellow: 10 },
    },
  ],
  maximumStatesPerScenario: 100_000,
  lpConstraintTolerance: LP_CONSTRAINT_TOLERANCE,
  parityTolerance: PARITY_TOLERANCE,
} as const;

type StageOutput = {
  objective: number;
  rootAction: string | null;
  logTail: string;
};

type ScenarioSolverResult =
  | { outcome: "verification_incomplete"; reason: string }
  | {
      outcome: "completed" | "failure";
      stages: Record<string, StageOutput>;
      parity: {
        passed: boolean;
        actionEqual: boolean;
        reachabilityDelta: number;
        expectedCostDelta: number;
        totalUsesDelta: number;
      };
      reason?: string;
    };

type ScenarioResult = {
  id: string;
  graph: { states: number; edges: number };
  exact: { action: string | null; reachability: number; expectedCost: number; totalUses: number };
  solver: ScenarioSolverResult;
};

const vite = await createServer({
  root: REPO_ROOT,
  logLevel: "error",
  server: { hmr: false, middlewareMode: true },
});
const compactModule = (await vite.ssrLoadModule("/benchmarks/compact-exact-graph.ts")) as {
  buildCompactStateGraph: typeof import("./compact-exact-graph").buildCompactStateGraph;
  solveCompactMinEf: typeof import("./compact-exact-graph").solveCompactMinEf;
};
const lpModule = (await vite.ssrLoadModule("/benchmarks/compact-lp-oracle.ts")) as {
  exportCompactOccupancyMps: typeof import("./compact-lp-oracle").exportCompactOccupancyMps;
  exportMaximumReachabilityMps: typeof import("./compact-lp-oracle").exportMaximumReachabilityMps;
  parseHighsSolution: typeof import("./compact-lp-oracle").parseHighsSolution;
  rootActionFromSolution: typeof import("./compact-lp-oracle").rootActionFromSolution;
};
const { buildCompactStateGraph, solveCompactMinEf } = compactModule;
const {
  exportCompactOccupancyMps,
  exportMaximumReachabilityMps,
  parseHighsSolution,
  rootActionFromSolution,
} = lpModule;

mkdirSync(dirname(OUTPUT), { recursive: true });
const { HIGHS_PATH: highsPath } = process.env;
const tool = highsPath
  ? {
      outcome: "available" as const,
      version: execFileSync(highsPath, ["--version"], { encoding: "utf8" }).trim(),
      executableSha256: sha256File(highsPath),
    }
  : { outcome: "unavailable" as const, reason: "HIGHS_PATH is not configured." };

const scenarios: ScenarioResult[] = [];
for (const scenario of CONTRACT.scenarios) {
  const built = buildCompactStateGraph(scenario.start, scenario.stock, {
    stateBudget: CONTRACT.maximumStatesPerScenario,
  });
  if (built.outcome !== "completed") {
    throw new Error(`Compact LP fixture ${scenario.id} exceeded its graph budget.`);
  }
  const graph = built.graph;
  const exact = solveCompactMinEf(graph);
  const exactRecord = {
    action: exact.root.action,
    reachability: exact.root.successProbability,
    expectedCost: exact.root.expectedCost,
    totalUses: exact.root.vector.blue + exact.root.vector.purple + exact.root.vector.yellow,
  };
  scenarios.push({
    id: scenario.id,
    graph: { states: graph.nodes.length, edges: graph.edgeCount },
    exact: exactRecord,
    solver:
      tool.outcome === "available"
        ? solveScenario(highsPath as string, scenario.id, graph, exact)
        : { outcome: "verification_incomplete", reason: tool.reason },
  });
}
await vite.close();

const provenance = collectResearchProvenance({
  repoRoot: REPO_ROOT,
  studyId: "compact-lp-oracle",
  protocolVersion: CONTRACT.version,
  contract: CONTRACT,
  sourceFiles: [
    "benchmarks/compact-exact-graph.ts",
    "benchmarks/compact-lp-oracle.ts",
    "benchmarks/run-compact-lp-oracle.ts",
  ],
});
const existing = readOptionalResearchReport(OUTPUT);
assertResearchReportCanBeWritten(existing, provenance);
const overallOutcome = scenarios.every((scenario) => scenario.solver.outcome === "completed")
  ? "completed"
  : scenarios.some((scenario) => scenario.solver.outcome === "failure")
    ? "failure"
    : "verification_incomplete";
writeFileSync(
  OUTPUT,
  `${JSON.stringify(
    {
      kind: CONTRACT.kind,
      version: CONTRACT.version,
      provenance,
      contract: CONTRACT,
      tool,
      outcome: overallOutcome,
      scenarios,
    },
    jsonNumberReplacer,
    2,
  )}\n`,
);
console.log(
  JSON.stringify({ output: OUTPUT, outcome: overallOutcome, scenarios: scenarios.length }),
);

function solveScenario(
  executable: string,
  scenarioId: string,
  graph: CompactStateGraph,
  exact: CompactMinEfResult,
): ScenarioSolverResult {
  try {
    const reachabilityModel = exportMaximumReachabilityMps(graph, `${scenarioId}_REACH`);
    const reachability = runStage(executable, scenarioId, "reachability", reachabilityModel);
    const costModel = exportCompactOccupancyMps(
      graph,
      "minimum_expected_cost",
      {
        minimumReachability: Math.max(0, reachability.solution.objective - LP_CONSTRAINT_TOLERANCE),
      },
      `${scenarioId}_COST`,
    );
    const cost = runStage(executable, scenarioId, "cost", costModel);
    const usesModel = exportCompactOccupancyMps(
      graph,
      "minimum_expected_uses",
      {
        minimumReachability: Math.max(0, reachability.solution.objective - LP_CONSTRAINT_TOLERANCE),
        maximumExpectedCost: cost.solution.objective + LP_CONSTRAINT_TOLERANCE,
      },
      `${scenarioId}_USES`,
    );
    const uses = runStage(executable, scenarioId, "uses", usesModel);
    const exactTotalUses =
      exact.root.vector.blue + exact.root.vector.purple + exact.root.vector.yellow;
    const parity = {
      actionEqual: rootActionFromSolution(graph, usesModel, uses.solution) === exact.root.action,
      reachabilityDelta: reachability.solution.objective - exact.root.successProbability,
      expectedCostDelta: cost.solution.objective - exact.root.expectedCost,
      totalUsesDelta: uses.solution.objective - exactTotalUses,
      passed: false,
    };
    parity.passed =
      parity.actionEqual &&
      Math.abs(parity.reachabilityDelta) <= PARITY_TOLERANCE &&
      Math.abs(parity.expectedCostDelta) <= PARITY_TOLERANCE &&
      Math.abs(parity.totalUsesDelta) <= PARITY_TOLERANCE;
    return {
      outcome: parity.passed ? "completed" : "failure",
      stages: {
        reachability: stageRecord(graph, reachability),
        cost: stageRecord(graph, cost),
        uses: stageRecord(graph, uses),
      },
      parity,
      ...(parity.passed ? {} : { reason: "LP and compact exact DP did not satisfy parity." }),
    };
  } catch (error) {
    return {
      outcome: "failure",
      stages: {},
      parity: {
        passed: false,
        actionEqual: false,
        reachabilityDelta: Number.NaN,
        expectedCostDelta: Number.NaN,
        totalUsesDelta: Number.NaN,
      },
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function runStage(
  executable: string,
  scenarioId: string,
  name: string,
  model: CompactOccupancyMps,
): { model: CompactOccupancyMps; solution: ParsedHighsSolution; log: string } {
  const artifactName = `${sanitizeArtifactName(scenarioId)}-${name}`;
  const mpsPath = `${ARTIFACT_PREFIX}-${artifactName}.mps`;
  const solutionPath = `${ARTIFACT_PREFIX}-${artifactName}.sol`;
  writeFileSync(mpsPath, model.text);
  rmSync(solutionPath, { force: true });
  const log = execFileSync(
    executable,
    [
      "--solver",
      "simplex",
      "--parallel",
      "off",
      "--random_seed",
      "0",
      "--solution_file",
      solutionPath,
      mpsPath,
    ],
    { encoding: "utf8", cwd: dirname(OUTPUT) },
  );
  const solution = parseHighsSolution(readFileSync(solutionPath, "utf8"));
  if (solution.modelStatus !== "Optimal" || solution.primalStatus !== "Feasible") {
    throw new Error(`${name} LP was not optimal and primal-feasible.`);
  }
  return { model, solution, log };
}

function stageRecord(
  graph: CompactStateGraph,
  stage: { model: CompactOccupancyMps; solution: ParsedHighsSolution; log: string },
): StageOutput {
  return {
    objective: stage.solution.objective,
    rootAction: rootActionFromSolution(graph, stage.model, stage.solution),
    logTail: stage.log.slice(-2_000),
  };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sanitizeArtifactName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}

function jsonNumberReplacer(_key: string, value: unknown): unknown {
  return typeof value === "number" && !Number.isFinite(value) ? String(value) : value;
}
