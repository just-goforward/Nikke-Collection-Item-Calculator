import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { ExactInteractiveEvaluation } from "./evaluator/exact-replan-types";
import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  fingerprintResearchArtifact,
  type ResearchArtifactFingerprint,
  type ResearchProvenance,
} from "./research-provenance.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRODUCT_WASM_PATH = "public/solver_rs.wasm";
const BASELINE_REPORT_PATH = "benchmarks/results/bounded-hybrid-quality-study-v1.json";
const OUTPUT_URL = new URL("./results/single-use-batching-study-v1.json", import.meta.url);
const SCENARIO_IDS = ["R10-balanced300", "SR0-balanced300"] as const;

type QualityModule = typeof import("./bounded-hybrid-quality");

type Report = {
  kind: "single-use-batching-study";
  version: 1;
  generatedAt: string;
  provenance: ResearchProvenance;
  baselineReport: ResearchArtifactFingerprint;
  productWasm: ResearchArtifactFingerprint;
  contract: ReturnType<typeof contract>;
  records: Array<{
    scenarioId: string;
    baseline: ExactInteractiveEvaluation;
    candidate: ExactInteractiveEvaluation;
    quality: ReturnType<QualityModule["classifyBoundedHybridQuality"]>;
    deltas: {
      expectedManualEntries: number | null;
      manualEntryProbability: number | null;
      successAttemptSelectionProbability: number | null;
      solveCalls: number;
      cachedNodes: number;
    };
  }>;
  decision: {
    resourceQualityGatePassed: boolean;
    manualEntryReductionObserved: boolean;
    interactionWorkloadMeasured: false;
    classification: "interaction_policy_tradeoff" | "rejected" | "verification_incomplete";
    productAdoptionAuthorized: false;
    blockers: string[];
  };
};

async function main() {
  const baselineReport = fingerprintResearchArtifact(REPO_ROOT, BASELINE_REPORT_PATH);
  const studyContract = contract(baselineReport.sha256);
  const provenance = collectResearchProvenance({
    repoRoot: REPO_ROOT,
    studyId: "single-use-batching-study-v1",
    protocolVersion: 1,
    contract: studyContract,
    sourceFiles: [
      "benchmarks/bounded-hybrid-quality.ts",
      "benchmarks/evaluator/exact-replan-gates.ts",
      "benchmarks/evaluator/exact-replan-node.ts",
      "benchmarks/evaluator/exact-replan-types.ts",
      "benchmarks/evaluator/exact-replan.ts",
      "benchmarks/min-ef-hp-model.ts",
      "benchmarks/min-ef-hp-policy.ts",
      "benchmarks/research-provenance.ts",
      "benchmarks/run-single-use-batching-study.ts",
      "benchmarks/scenarios/fixed-grid.ts",
      "benchmarks/single-use-batching.ts",
      "src/wasm/rustMinEfCore.ts",
      "src/wasm/rustPhase2Core.ts",
    ],
    wasmPath: PRODUCT_WASM_PATH,
  });
  assertResearchReportCanBeWritten(await readExistingReport(), provenance);
  const [wasm, baselineJson] = await Promise.all([
    readFile(new URL(`../${PRODUCT_WASM_PATH}`, import.meta.url)),
    readFile(new URL(`../${BASELINE_REPORT_PATH}`, import.meta.url), "utf8"),
  ]);
  const storedBaseline = JSON.parse(baselineJson) as {
    kind?: string;
    productWasm?: ResearchArtifactFingerprint;
    records?: Array<{ scenarioId?: string; baseline?: ExactInteractiveEvaluation }>;
  };
  const productWasm = fingerprintResearchArtifact(REPO_ROOT, PRODUCT_WASM_PATH);
  if (
    storedBaseline.kind !== "bounded-hybrid-quality-study" ||
    storedBaseline.productWasm?.sha256 !== productWasm.sha256
  ) {
    throw new Error("Stored exact baseline does not match the current product WASM.");
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
    const hpModel = (await server.ssrLoadModule(
      "/benchmarks/min-ef-hp-model.ts",
    )) as typeof import("./min-ef-hp-model");
    const hpPolicy = (await server.ssrLoadModule(
      "/benchmarks/min-ef-hp-policy.ts",
    )) as typeof import("./min-ef-hp-policy");
    const batching = (await server.ssrLoadModule(
      "/benchmarks/single-use-batching.ts",
    )) as typeof import("./single-use-batching");
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
      if (!scenario) throw new Error(`Missing single-use scenario: ${scenarioId}.`);
      const baseline = storedBaseline.records?.find(
        (record) => record.scenarioId === scenarioId,
      )?.baseline;
      if (baseline?.status !== "completed") {
        throw new Error(`Missing completed exact baseline for ${scenarioId}.`);
      }
      const ladder = hpPolicy.createHpLadderSession(
        await instantiate(wasm),
        await instantiate(wasm),
        hpModel.hpCandidateById(hpModel.HP_BASELINE_ID),
      );
      const candidate = evaluator.evaluateExactInteractiveReplan(scenario, {
        modelId: "current-policy-forced-single-use-v1",
        policySolver: batching.forceSingleUseBatching(ladder.policySolver),
        timeBudgetMs: studyContract.exactEvaluationBudgetMs,
        toleranceOverride: 0,
      });
      ladder.release();
      const completed = candidate.status === "completed" ? candidate : null;
      records.push({
        scenarioId,
        baseline,
        candidate,
        quality: quality.classifyBoundedHybridQuality(baseline, candidate),
        deltas: {
          expectedManualEntries: completed
            ? completed.expectedManualEntries - baseline.expectedManualEntries
            : null,
          manualEntryProbability: completed
            ? completed.manualEntryProbability - baseline.manualEntryProbability
            : null,
          successAttemptSelectionProbability: completed
            ? completed.successAttemptSelectionProbability -
              baseline.successAttemptSelectionProbability
            : null,
          solveCalls: candidate.solveCalls - baseline.solveCalls,
          cachedNodes: candidate.cachedNodes - baseline.cachedNodes,
        },
      });
      console.log(
        `${scenarioId}: ${candidate.status} manualDelta=${
          completed ? completed.expectedManualEntries - baseline.expectedManualEntries : "n/a"
        }`,
      );
    }

    const complete = records.every((record) => record.candidate.status === "completed");
    const resourceQualityGatePassed = records.every(
      (record) => record.quality.grade === "scenario_pass",
    );
    const manualEntryReductionObserved = records.every(
      (record) =>
        record.deltas.expectedManualEntries !== null &&
        record.deltas.expectedManualEntries < -1e-12,
    );
    const classification = !complete
      ? "verification_incomplete"
      : resourceQualityGatePassed && manualEntryReductionObserved
        ? "interaction_policy_tradeoff"
        : "rejected";
    const blockers = [
      ...records.flatMap((record) =>
        record.quality.grade === "scenario_pass"
          ? []
          : [
              `${record.scenarioId}: ${record.quality.grade} (${record.quality.reasons.join(", ")})`,
            ],
      ),
      "Expected user confirmation/recalculation workload is not measured by the exact evaluator.",
    ];
    const report: Report = {
      kind: "single-use-batching-study",
      version: 1,
      generatedAt: new Date().toISOString(),
      provenance,
      baselineReport,
      productWasm,
      contract: studyContract,
      records,
      decision: {
        resourceQualityGatePassed,
        manualEntryReductionObserved,
        interactionWorkloadMeasured: false,
        classification,
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

function contract(baselineReportSha256: string) {
  return {
    objective: "separate_manual_count_entry_from_solver_policy_by_forcing_single_use_runs",
    baseline: "bounded-hybrid-quality-study-v1 current product records",
    candidate: "same_min-ef_phase2_policy_with_run_count_forced_to_one",
    exactEvaluationBudgetMs: 300_000,
    scenarioIds: SCENARIO_IDS,
    baselineReportSha256,
  } as const;
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
