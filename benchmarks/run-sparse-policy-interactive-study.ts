import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";

import type { ExactInteractiveEvaluation } from "./evaluator/exact-replan-types";
import { envValue, parseList, parsePositiveInteger } from "./runner-utils.ts";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const reportId = envValue("SPARSE_PI_REPORT_ID") || "default";
if (!/^[a-z0-9-]+$/i.test(reportId)) throw new Error("Invalid sparse PI report id.");
const OUTPUT_FILE = new URL(
  `./results/sparse-policy-interactive-study-${reportId}.json`,
  import.meta.url,
);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);
const HP_REPORT_URL = new URL("./results/min-ef-hp-study.json", import.meta.url);
const DEFAULT_SCENARIOS = ["R14e900-yellow30", "R10-balanced300"] as const;

const scenarioIds = parseList(envValue("SPARSE_PI_INTERACTIVE_SCENARIOS"), DEFAULT_SCENARIOS);
const evaluationBudgetMs = parsePositiveInteger(
  envValue("SPARSE_PI_INTERACTIVE_BUDGET_MS"),
  300_000,
);
const policyBudgetMs = parsePositiveInteger(envValue("SPARSE_PI_TIME_BUDGET_MS"), 300_000);
const maxStates = parsePositiveInteger(envValue("SPARSE_PI_MAX_STATES"), 1_200_000);
const maxIterations = parsePositiveInteger(envValue("SPARSE_PI_MAX_ITERATIONS"), 40);
const acceptIterationBudget = envValue("SPARSE_PI_ACCEPT_ITERATION_BUDGET") === "1";
const reuseHpBaseline = envValue("SPARSE_PI_REUSE_HP_BASELINE") === "1";
const wasm = await readFile(WASM_URL);
const hpReport = reuseHpBaseline
  ? (JSON.parse(await readFile(HP_REPORT_URL, "utf8")) as {
      exact?: {
        records?: Array<{
          candidateId?: string;
          scenarioId?: string;
          evaluation?: ExactInteractiveEvaluation;
        }>;
      };
    })
  : null;
await mkdir(RESULTS_DIRECTORY, { recursive: true });

async function instantiate() {
  const result = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  return result instanceof WebAssembly.Instance ? result : result.instance;
}

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
  const sparseModule = (await server.ssrLoadModule(
    "/benchmarks/sparse-policy-ladder.ts",
  )) as typeof import("./sparse-policy-ladder");
  const hpPolicy = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-policy.ts",
  )) as typeof import("./min-ef-hp-policy");
  const hpModel = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-model.ts",
  )) as typeof import("./min-ef-hp-model");
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
    if (!scenario) throw new Error(`Unknown sparse policy interactive scenario: ${scenarioId}`);

    const storedBaseline = hpReport?.exact?.records?.find(
      (record) => record.candidateId === hpModel.HP_BASELINE_ID && record.scenarioId === scenarioId,
    )?.evaluation;
    const baselineLadder = storedBaseline
      ? null
      : hpPolicy.createHpLadderSession(
          await instantiate(),
          await instantiate(),
          hpModel.hpCandidateById(hpModel.HP_BASELINE_ID),
        );

    const candidateMinEfInstance = await instantiate();
    const candidateSparseInstance = await instantiate();
    const candidateLadder = sparseModule.createSparseFallbackLadderSession(
      candidateMinEfInstance,
      candidateSparseInstance,
      {
        acceptIterationBudget,
        maxIterations,
        maxStates,
        memoTier: 22,
        timeBudgetMs: policyBudgetMs,
      },
    );

    const baseline =
      storedBaseline ??
      evaluator.evaluateExactInteractiveReplan(scenario, {
        modelId: "rust-min-ef-to-phase2",
        ...(baselineLadder ? { policySolver: baselineLadder.policySolver } : {}),
        timeBudgetMs: evaluationBudgetMs,
        toleranceOverride: 0,
      });
    const candidate = evaluator.evaluateExactInteractiveReplan(scenario, {
      modelId: "rust-min-ef-to-sparse-policy-iteration-v1",
      policySolver: candidateLadder.policySolver,
      timeBudgetMs: evaluationBudgetMs,
      toleranceOverride: 0,
    });
    records.push({
      scenarioId,
      baseline,
      candidate,
      baselineSource: storedBaseline ? "min-ef-hp-study-v1" : "current-run",
      baselineTraces: baselineLadder?.traces() ?? [],
      candidateTraces: candidateLadder.traces(),
      candidatePolicyDecisions: candidateLadder.sparseDecisions(),
    });
    console.log(
      `${scenarioId}: baseline=${baseline.status} candidate=${candidate.status} sparseCalls=${candidateLadder.sparseDecisions().length}`,
    );
  }

  await writeFile(
    OUTPUT_FILE,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        kind: "sparse-policy-interactive-study",
        reportId,
        options: {
          evaluationBudgetMs,
          acceptIterationBudget,
          maxIterations,
          maxStates,
          memoTier: 22,
          policyBudgetMs,
          reuseHpBaseline,
          scenarioIds,
          tolerance: 0,
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
