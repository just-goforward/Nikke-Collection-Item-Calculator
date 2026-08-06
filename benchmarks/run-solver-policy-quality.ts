import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";

import {
  assertLatencyRecordConsistency,
  createLatencyMeasurementProtocol,
  summarizeLatencySamples,
} from "./latency-report.ts";
import { envValue } from "./runner-utils.ts";
import type { SolverScenario } from "./scenarios/fixed-grid";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const DEFAULT_OUTPUT_FILE = new URL("./results/solver-policy-quality.json", import.meta.url);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);
const DEFAULT_SCENARIOS = ["R14e900-yellow30", "SR14e2900-observedPurpleHigh"] as const;
const POLICY_IDS = ["phase2_baseline", "phase2_mc_rerank", "phase2_exact_rerank"] as const;

function parseList(value: string | undefined, fallback: readonly string[]) {
  const parsed = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function failureOutcome(error: unknown) {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : null;
  return {
    outcome:
      status === 1
        ? ("budget_exceeded" as const)
        : status === 2
          ? ("memo_full" as const)
          : ("failure" as const),
    error: error instanceof Error ? error.message : String(error),
  };
}

const timeBudgetMs = parsePositiveInteger(envValue("SOLVER_QUALITY_TIME_BUDGET_MS"), 60_000);
const latencyRepeats = parsePositiveInteger(envValue("SOLVER_QUALITY_LATENCY_REPEATS"), 11);
const latencyProtocol = createLatencyMeasurementProtocol(latencyRepeats);
const outputFileValue = envValue("SOLVER_QUALITY_OUTPUT_FILE");
const outputFile = outputFileValue
  ? new URL(outputFileValue, RESULTS_DIRECTORY)
  : DEFAULT_OUTPUT_FILE;
await mkdir(RESULTS_DIRECTORY, { recursive: true });

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

try {
  const rustResearch = (await server.ssrLoadModule(
    "/src/wasm/rustResearchLoader.ts",
  )) as typeof import("../src/wasm/rustResearchLoader");
  const policies = (await server.ssrLoadModule(
    "/benchmarks/rust-policy-solvers.ts",
  )) as typeof import("./rust-policy-solvers");
  const evaluator = (await server.ssrLoadModule(
    "/benchmarks/evaluator/exact-replan.ts",
  )) as typeof import("./evaluator/exact-replan");
  const quality = (await server.ssrLoadModule(
    "/benchmarks/rerank-quality.ts",
  )) as typeof import("./rerank-quality");
  const fixedGrid = (await server.ssrLoadModule(
    "/benchmarks/scenarios/fixed-grid.ts",
  )) as typeof import("./scenarios/fixed-grid");
  const product = (await server.ssrLoadModule(
    "/benchmarks/scenarios/rerank-product.ts",
  )) as typeof import("./scenarios/rerank-product");
  const supplemental = (await server.ssrLoadModule(
    "/benchmarks/scenarios/rerank-supplemental.ts",
  )) as typeof import("./scenarios/rerank-supplemental");

  const allScenarios: SolverScenario[] = [
    ...fixedGrid.FIXED_SAFETY_GRID,
    ...product.PRODUCT_RERANK_SCENARIOS,
    ...supplemental.RERANK_SUPPLEMENTAL_SCENARIOS,
  ];
  const byId = new Map(allScenarios.map((scenario) => [scenario.id, scenario]));
  const requestedIds = parseList(envValue("SOLVER_QUALITY_SCENARIOS"), DEFAULT_SCENARIOS);
  const scenarios = requestedIds.map((id) => {
    const scenario = byId.get(id);
    if (!scenario) {
      throw new Error(
        `Unknown solver quality scenario ${id}. Known scenarios: ${[...byId.keys()].join(", ")}`,
      );
    }
    return scenario;
  });
  const wasm = await readFile(WASM_URL);

  async function createPolicySolver(policyId: (typeof POLICY_IDS)[number]) {
    const instantiated = (await WebAssembly.instantiate(wasm)) as
      | WebAssembly.Instance
      | { instance: WebAssembly.Instance };
    const instance =
      instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
    const solver = rustResearch.createRustPhase2ResearchSolverFromInstance(instance);
    return policies.createRustPolicySolvers(solver)[policyId];
  }

  async function evaluatePolicy(scenario: SolverScenario, policyId: (typeof POLICY_IDS)[number]) {
    const policySolver = await createPolicySolver(policyId);
    return evaluator.evaluateExactInteractiveReplan(scenario, {
      modelId: policyId,
      policySolver,
      toleranceOverride: 0,
      timeBudgetMs,
    });
  }

  async function measureRootLatency(
    scenario: SolverScenario,
    policyId: (typeof POLICY_IDS)[number],
  ) {
    const policySolver = await createPolicySolver(policyId);
    const samples: number[] = [];
    for (let index = 0; index < latencyRepeats; index += 1) {
      const startedAt = performance.now();
      try {
        policySolver({ start: scenario.start, stock: scenario.stock, strategy: "supply" });
      } catch (error) {
        return {
          ...failureOutcome(error),
          elapsedMs: performance.now() - startedAt,
          repeats: samples.length + 1,
        };
      }
      samples.push(performance.now() - startedAt);
    }
    return summarizeLatencySamples(samples, latencyProtocol);
  }

  const records = [];
  for (const scenario of scenarios) {
    const evaluations = {
      phase2_baseline: await evaluatePolicy(scenario, "phase2_baseline"),
      phase2_mc_rerank: await evaluatePolicy(scenario, "phase2_mc_rerank"),
      phase2_exact_rerank: await evaluatePolicy(scenario, "phase2_exact_rerank"),
    };
    const latencies = {
      phase2_baseline: await measureRootLatency(scenario, "phase2_baseline"),
      phase2_mc_rerank: await measureRootLatency(scenario, "phase2_mc_rerank"),
      phase2_exact_rerank: await measureRootLatency(scenario, "phase2_exact_rerank"),
    };
    const baselineP95 =
      latencies.phase2_baseline.outcome === "completed"
        ? latencies.phase2_baseline.warmP95Ms
        : null;
    const exactP95 =
      latencies.phase2_exact_rerank.outcome === "completed"
        ? latencies.phase2_exact_rerank.warmP95Ms
        : null;
    const exactLatencyGate = quality.passesQualityLatencyGate(baselineP95, exactP95);
    const mcP95 =
      latencies.phase2_mc_rerank.outcome === "completed"
        ? latencies.phase2_mc_rerank.warmP95Ms
        : null;
    const mcLatencyGate = quality.passesQualityLatencyGate(baselineP95, mcP95);
    records.push({
      scenario,
      evaluations,
      grades: {
        phase2_mc_rerank: quality.classifyExactInteractiveCandidate(
          evaluations.phase2_baseline,
          evaluations.phase2_mc_rerank,
        ),
        phase2_exact_rerank: quality.classifyExactInteractiveCandidate(
          evaluations.phase2_baseline,
          evaluations.phase2_exact_rerank,
        ),
      },
      latencies,
      exactLatencyGate,
      mcLatencyGate,
    });
  }

  const selectedScenarioGrades = {
    phase2_mc_rerank: quality.classifyExactInteractiveCandidateSet(
      records.map((record) => ({
        baseline: record.evaluations.phase2_baseline,
        candidate: record.evaluations.phase2_mc_rerank,
      })),
      records.every((record) => record.mcLatencyGate),
    ),
    phase2_exact_rerank: quality.classifyExactInteractiveCandidateSet(
      records.map((record) => ({
        baseline: record.evaluations.phase2_baseline,
        candidate: record.evaluations.phase2_exact_rerank,
      })),
      records.every((record) => record.exactLatencyGate),
    ),
  };
  const report = {
    kind: "solver-policy-quality",
    version: 2,
    generatedAt: new Date().toISOString(),
    options: {
      scenarioIds: requestedIds,
      timeBudgetMs,
      horizonFactor: 0.75,
      normPower: 3,
      tolerance: 0,
    },
    measurementProtocol: {
      latency: latencyProtocol,
    },
    decisionPolicy: {
      classification: quality.QUALITY_CLASSIFICATION_POLICY,
      latencyGate: quality.QUALITY_LATENCY_GATE_POLICY,
    },
    decisionScope: {
      gradesApplyOnlyToSelectedScenarios: true,
      productAdoptionAuthorized: false,
    },
    selectedScenarioGrades,
    records,
  };
  for (const record of records) {
    for (const policyId of POLICY_IDS) {
      const latency = record.latencies[policyId];
      if (latency.outcome === "completed") {
        assertLatencyRecordConsistency(latency, latencyProtocol);
      }
    }
  }
  await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        kind: report.kind,
        options: report.options,
        decisionScope: report.decisionScope,
        selectedScenarioGrades,
        records: records.map((record) => ({
          scenarioId: record.scenario.id,
          grades: record.grades,
          statuses: Object.fromEntries(
            POLICY_IDS.map((policyId) => [policyId, record.evaluations[policyId].status]),
          ),
          latencies: record.latencies,
          exactLatencyGate: record.exactLatencyGate,
          mcLatencyGate: record.mcLatencyGate,
        })),
        output: outputFile.pathname,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
