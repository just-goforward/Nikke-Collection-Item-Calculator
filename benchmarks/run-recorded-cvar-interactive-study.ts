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
const ROOT_SCREEN_PATH = "benchmarks/results/recorded-cvar-root-screen-v1.json";
const OUTPUT_URL = new URL("./results/recorded-cvar-interactive-study-v1.json", import.meta.url);
const SCENARIO_IDS = ["R10-balanced300", "SR0-balanced300"] as const;

type QualityModule = typeof import("./bounded-hybrid-quality");
type CvarSummary = import("./recorded-cvar-ladder").RecordedCvarLadderSummary;

type Report = {
  kind: "recorded-cvar-interactive-study";
  version: 1;
  generatedAt: string;
  provenance: ResearchProvenance;
  baselineReport: ResearchArtifactFingerprint;
  rootScreen: ResearchArtifactFingerprint;
  productWasm: ResearchArtifactFingerprint;
  contract: ReturnType<typeof contract>;
  qualityPolicy: QualityModule["BOUNDED_HYBRID_QUALITY_POLICY"];
  records: Array<{
    scenarioId: string;
    baseline: ExactInteractiveEvaluation;
    candidate: ExactInteractiveEvaluation;
    quality: ReturnType<QualityModule["classifyBoundedHybridQuality"]>;
    candidateBackendSummary: CvarSummary;
  }>;
  decision: {
    exactQualityGatePassed: boolean;
    everyScenarioNonWorse: boolean;
    strictBenefitObserved: boolean;
    cvarDecisionChanges: number;
    productAdoptionAuthorized: false;
    blockers: string[];
  };
};

async function main() {
  const baselineReport = fingerprintResearchArtifact(REPO_ROOT, BASELINE_REPORT_PATH);
  const rootScreen = fingerprintResearchArtifact(REPO_ROOT, ROOT_SCREEN_PATH);
  const studyContract = contract(baselineReport.sha256, rootScreen.sha256);
  const provenance = collectResearchProvenance({
    repoRoot: REPO_ROOT,
    studyId: "recorded-cvar-interactive-study-v1",
    protocolVersion: 1,
    contract: studyContract,
    sourceFiles: [
      "benchmarks/bounded-hybrid-quality.ts",
      "benchmarks/evaluator/exact-replan-gates.ts",
      "benchmarks/evaluator/exact-replan-node.ts",
      "benchmarks/evaluator/exact-replan-types.ts",
      "benchmarks/evaluator/exact-replan.ts",
      "benchmarks/recorded-cvar-ladder.ts",
      "benchmarks/recorded-cvar-policy.ts",
      "benchmarks/research-provenance.ts",
      "benchmarks/run-recorded-cvar-interactive-study.ts",
      "benchmarks/scenarios/fixed-grid.ts",
      "rust/solver-rs/src/cvar.rs",
      "rust/solver-rs/src/lib.rs",
      "src/wasm/rustCoreExports.ts",
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
    const ladderModule = (await server.ssrLoadModule(
      "/benchmarks/recorded-cvar-ladder.ts",
    )) as typeof import("./recorded-cvar-ladder");
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
      if (!scenario) throw new Error(`Missing recorded-CVaR scenario: ${scenarioId}.`);
      const baseline = storedBaseline.records?.find(
        (record) => record.scenarioId === scenarioId,
      )?.baseline;
      if (baseline?.status !== "completed") {
        throw new Error(`Missing completed exact baseline for ${scenarioId}.`);
      }
      const ladder = ladderModule.createRecordedCvarFallbackLadderSession(
        await instantiate(wasm),
        await instantiate(wasm),
        await instantiate(wasm),
      );
      const candidate = evaluator.evaluateExactInteractiveReplan(scenario, {
        modelId: "rust-min-ef-to-recorded-cvar-to-phase2-v1",
        policySolver: ladder.policySolver,
        timeBudgetMs: studyContract.exactEvaluationBudgetMs,
        toleranceOverride: 0,
      });
      const candidateBackendSummary = ladder.summary();
      ladder.release();
      records.push({
        scenarioId,
        baseline,
        candidate,
        quality: quality.classifyBoundedHybridQuality(baseline, candidate),
        candidateBackendSummary,
      });
      console.log(
        `${scenarioId}: ${candidate.status} cvarAttempts=${candidateBackendSummary.cvarAttempts} ` +
          `changes=${candidateBackendSummary.cvarDecisionChanges}`,
      );
    }

    const everyScenarioNonWorse = records.every(
      (record) => record.quality.grade === "scenario_pass",
    );
    const strictBenefitObserved = records.some((record) => record.quality.gates.strictBenefit);
    const cvarDecisionChanges = records.reduce(
      (sum, record) => sum + record.candidateBackendSummary.cvarDecisionChanges,
      0,
    );
    const blockers = records.flatMap((record) =>
      record.quality.grade === "scenario_pass"
        ? []
        : [`${record.scenarioId}: ${record.quality.grade} (${record.quality.reasons.join(", ")})`],
    );
    if (!strictBenefitObserved)
      blockers.push("No strict success-probability or interactive-F benefit.");
    if (cvarDecisionChanges === 0) {
      blockers.push("Recorded CVaR did not change any decision reached by the product ladder.");
    }
    const report: Report = {
      kind: "recorded-cvar-interactive-study",
      version: 1,
      generatedAt: new Date().toISOString(),
      provenance,
      baselineReport,
      rootScreen,
      productWasm,
      contract: studyContract,
      qualityPolicy: quality.BOUNDED_HYBRID_QUALITY_POLICY,
      records,
      decision: {
        exactQualityGatePassed:
          everyScenarioNonWorse && strictBenefitObserved && cvarDecisionChanges > 0,
        everyScenarioNonWorse,
        strictBenefitObserved,
        cvarDecisionChanges,
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

function contract(baselineReportSha256: string, rootScreenSha256: string) {
  return {
    objective: "test_full_recorded_cvar_only_on_product_phase2_fallback_states",
    baseline: "bounded-hybrid-quality-study-v1 current product records",
    candidate: "rust-min-ef-tier21-to-recorded-cvar-to-phase2-on-cvar-failure",
    alpha: 0.9,
    etas: [0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6],
    exactEvaluationBudgetMs: 300_000,
    horizonFactor: 0.75,
    normPower: 3,
    scenarioIds: SCENARIO_IDS,
    tolerance: 0,
    baselineReportSha256,
    rootScreenSha256,
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
