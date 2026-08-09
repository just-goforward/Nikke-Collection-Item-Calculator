import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { ExactInteractiveEvaluation } from "./evaluator/exact-replan-types";
import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  fingerprintResearchArtifact,
  type ResearchProvenance,
} from "./research-provenance.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRODUCT_WASM_PATH = "public/solver_rs.wasm";
const CANDIDATE_WASM_PATH = "output/solver_rs-prioritized-sparse-pi.wasm";
const OUTPUT_URL = new URL("./results/bounded-hybrid-quality-study-v1.json", import.meta.url);
const SCENARIO_IDS = ["R10-balanced300", "SR0-balanced300"] as const;
const CONTRACT = {
  objective: "test_bounded_max_path_prioritized_fallback_in_exact_interactive_flow",
  baseline: "rust-min-ef-tier21-to-rust-phase2-tier22",
  candidate: "rust-min-ef-tier21-to-max-path-prioritized-phase2",
  candidateOptions: {
    horizonFactor: 0.75,
    maxPasses: 4,
    maxStates: 1_200_000,
    maxUpdatesPerPass: 256,
    memoTier: 22,
    normPower: 3,
    priorityMode: "max_path_probability",
    tolerance: 0,
  },
  exactEvaluationBudgetMs: 300_000,
  productWasmBudgetBytes: 115_000,
  scenarioIds: SCENARIO_IDS,
} as const;

type QualityModule = typeof import("./bounded-hybrid-quality");
type HpTrace = import("./min-ef-hp-policy").HpLadderTrace;
type PrioritizedSummary = import("./prioritized-policy-ladder").PrioritizedFallbackSummary;

type Report = {
  kind: "bounded-hybrid-quality-study";
  version: 1;
  generatedAt: string;
  provenance: ResearchProvenance;
  productWasm: ReturnType<typeof fingerprintResearchArtifact>;
  contract: typeof CONTRACT;
  qualityPolicy: QualityModule["BOUNDED_HYBRID_QUALITY_POLICY"];
  records: Array<{
    scenarioId: string;
    baseline: ExactInteractiveEvaluation;
    candidate: ExactInteractiveEvaluation;
    quality: ReturnType<QualityModule["classifyBoundedHybridQuality"]>;
    baselineBackendSummary: ReturnType<typeof summarizeHpTraces>;
    candidateBackendSummary: PrioritizedSummary;
  }>;
  decision: {
    exactQualityGatePassed: boolean;
    everyScenarioNonWorse: boolean;
    strictBenefitObserved: boolean;
    sizeGatePassed: boolean;
    productAdoptionAuthorized: false;
    blockers: string[];
  };
};

async function main() {
  const provenance = collectResearchProvenance({
    repoRoot: REPO_ROOT,
    studyId: "bounded-hybrid-quality-study-v1",
    protocolVersion: 1,
    contract: CONTRACT,
    sourceFiles: [
      "benchmarks/bounded-hybrid-quality.ts",
      "benchmarks/evaluator/exact-replan-gates.ts",
      "benchmarks/evaluator/exact-replan-node.ts",
      "benchmarks/evaluator/exact-replan-types.ts",
      "benchmarks/evaluator/exact-replan.ts",
      "benchmarks/min-ef-hp-model.ts",
      "benchmarks/min-ef-hp-policy.ts",
      "benchmarks/prioritized-policy-ladder.ts",
      "benchmarks/research-provenance.ts",
      "benchmarks/run-bounded-hybrid-quality-study.ts",
      "benchmarks/rust-prioritized-sparse-pi.ts",
      "benchmarks/scenarios/fixed-grid.ts",
      "rust/solver-rs/src/prioritized_sparse_pi.rs",
      "src/solver/domain.ts",
      "src/wasm/rustCoreExports.ts",
      "src/wasm/rustMinEfCore.ts",
      "src/wasm/rustPhase2Core.ts",
      "src/wasm/rustProductInput.ts",
      "src/wasm/rustProductView.ts",
    ],
    wasmPath: CANDIDATE_WASM_PATH,
  });
  assertResearchReportCanBeWritten(await readExistingReport(), provenance);

  const [productWasmBytes, candidateWasmBytes] = await Promise.all([
    readFile(new URL(`../${PRODUCT_WASM_PATH}`, import.meta.url)),
    readFile(new URL(`../${CANDIDATE_WASM_PATH}`, import.meta.url)),
  ]);
  const productWasm = fingerprintResearchArtifact(REPO_ROOT, PRODUCT_WASM_PATH);
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
    const hpModel = (await server.ssrLoadModule(
      "/benchmarks/min-ef-hp-model.ts",
    )) as typeof import("./min-ef-hp-model");
    const hpPolicy = (await server.ssrLoadModule(
      "/benchmarks/min-ef-hp-policy.ts",
    )) as typeof import("./min-ef-hp-policy");
    const prioritized = (await server.ssrLoadModule(
      "/benchmarks/prioritized-policy-ladder.ts",
    )) as typeof import("./prioritized-policy-ladder");
    const quality = (await server.ssrLoadModule(
      "/benchmarks/bounded-hybrid-quality.ts",
    )) as QualityModule;
    const fixed = (await server.ssrLoadModule(
      "/benchmarks/scenarios/fixed-grid.ts",
    )) as typeof import("./scenarios/fixed-grid");
    const scenarios = new Map(fixed.FIXED_SAFETY_GRID.map((scenario) => [scenario.id, scenario]));
    const records: Report["records"] = [];

    for (const scenarioId of SCENARIO_IDS) {
      const scenario = scenarios.get(scenarioId);
      if (!scenario) throw new Error(`Missing bounded-hybrid scenario: ${scenarioId}.`);

      const baselineLadder = hpPolicy.createHpLadderSession(
        await instantiate(productWasmBytes),
        await instantiate(productWasmBytes),
        hpModel.hpCandidateById(hpModel.HP_BASELINE_ID),
      );
      const baseline = evaluator.evaluateExactInteractiveReplan(scenario, {
        modelId: "rust-min-ef-to-phase2-current",
        policySolver: baselineLadder.policySolver,
        timeBudgetMs: CONTRACT.exactEvaluationBudgetMs,
        toleranceOverride: 0,
      });
      const baselineBackendSummary = summarizeHpTraces(baselineLadder.traces());
      baselineLadder.release();
      console.log(
        `${scenarioId} baseline: ${baseline.status} elapsed=${baseline.elapsedMs}ms ` +
          `solves=${baseline.solveCalls}`,
      );

      const candidateLadder = prioritized.createPrioritizedFallbackLadderSession(
        await instantiate(productWasmBytes),
        await instantiate(candidateWasmBytes),
        CONTRACT.candidateOptions,
      );
      const candidate = evaluator.evaluateExactInteractiveReplan(scenario, {
        modelId: "rust-min-ef-to-bounded-max-path-prioritized-v1",
        policySolver: candidateLadder.policySolver,
        timeBudgetMs: CONTRACT.exactEvaluationBudgetMs,
        toleranceOverride: 0,
      });
      const candidateBackendSummary = candidateLadder.summary();
      candidateLadder.release();
      console.log(
        `${scenarioId} candidate: ${candidate.status} elapsed=${candidate.elapsedMs}ms ` +
          `solves=${candidate.solveCalls} fallbacks=${candidateBackendSummary.prioritizedCalls}`,
      );

      records.push({
        scenarioId,
        baseline,
        candidate,
        quality: quality.classifyBoundedHybridQuality(baseline, candidate),
        baselineBackendSummary,
        candidateBackendSummary,
      });
    }

    const everyScenarioNonWorse = records.every(
      (record) => record.quality.grade === "scenario_pass",
    );
    const strictBenefitObserved = records.some((record) => record.quality.gates.strictBenefit);
    const sizeGatePassed = candidateWasmBytes.byteLength <= CONTRACT.productWasmBudgetBytes;
    const blockers = records.flatMap((record) =>
      record.quality.grade === "scenario_pass"
        ? []
        : [`${record.scenarioId}: ${record.quality.grade} (${record.quality.reasons.join(", ")})`],
    );
    if (!strictBenefitObserved)
      blockers.push("No strict success-probability or interactive-F benefit.");
    if (!sizeGatePassed) {
      blockers.push(
        `Candidate WASM is ${candidateWasmBytes.byteLength} bytes, over the ` +
          `${CONTRACT.productWasmBudgetBytes}-byte product budget.`,
      );
    }
    const report: Report = {
      kind: "bounded-hybrid-quality-study",
      version: 1,
      generatedAt: new Date().toISOString(),
      provenance,
      productWasm,
      contract: CONTRACT,
      qualityPolicy: quality.BOUNDED_HYBRID_QUALITY_POLICY,
      records,
      decision: {
        exactQualityGatePassed: everyScenarioNonWorse && strictBenefitObserved,
        everyScenarioNonWorse,
        strictBenefitObserved,
        sizeGatePassed,
        productAdoptionAuthorized: false,
        blockers,
      },
    };
    await writeFile(OUTPUT_URL, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report.decision));
  } finally {
    await server.close();
  }
}

function summarizeHpTraces(traces: readonly HpTrace[]) {
  const summary = {
    calls: traces.length,
    minEfOutcomes: { completed: 0, memo_full: 0, budget_exceeded: 0, failure: 0 },
    phase2Outcomes: {
      completed: 0,
      memo_full: 0,
      budget_exceeded: 0,
      failure: 0,
      not_run: 0,
    },
  };
  for (const trace of traces) {
    summary.minEfOutcomes[trace.minEfOutcome] += 1;
    summary.phase2Outcomes[trace.phase2Outcome] += 1;
  }
  return summary;
}

async function instantiate(wasm: Uint8Array): Promise<WebAssembly.Instance> {
  const result = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  return result instanceof WebAssembly.Instance ? result : result.instance;
}

async function readExistingReport(): Promise<Report | null> {
  try {
    return JSON.parse(await readFile(OUTPUT_URL, "utf8")) as Report;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

void main();
