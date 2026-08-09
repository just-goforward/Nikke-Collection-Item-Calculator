import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  type ResearchProvenance,
} from "./research-provenance.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRODUCT_WASM_PATH = "public/solver_rs.wasm";
const OUTPUT_URL = new URL("./results/recorded-cvar-root-screen-v1.json", import.meta.url);
const CONTRACT = {
  objective: "screen_full_recorded_cvar_policy_under_success_and_mean_guardrails",
  alpha: 0.9,
  etas: [0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6],
  horizonFactor: 0.75,
  normPower: 3,
  tolerance: 0,
  candidateCvarMustStrictlyImprove: true,
  candidateMeanMustBeNonWorse: true,
  candidateSuccessMustBeNonWorse: true,
  decisionChange: "first_action_or_recommended_run_count",
} as const;

type Decision = import("./recorded-cvar-policy").RecordedCvarDecision;

type Report = {
  kind: "recorded-cvar-root-screen";
  version: 1;
  generatedAt: string;
  provenance: ResearchProvenance;
  contract: typeof CONTRACT;
  records: Array<{
    scenarioId: string;
    elapsedMs: number;
    outcome: "completed" | "failure";
    errorMessage: string | null;
    decision: Decision | null;
  }>;
  decision: {
    completed: number;
    failures: number;
    recordedPolicySelected: number;
    decisionChanges: string[];
    exactInteractiveRequired: boolean;
    productAdoptionAuthorized: false;
  };
};

async function main() {
  const provenance = collectResearchProvenance({
    repoRoot: REPO_ROOT,
    studyId: "recorded-cvar-root-screen-v1",
    protocolVersion: 1,
    contract: CONTRACT,
    sourceFiles: [
      "benchmarks/recorded-cvar-policy.ts",
      "benchmarks/research-provenance.ts",
      "benchmarks/run-recorded-cvar-root-screen.ts",
      "benchmarks/scenarios/fixed-grid.ts",
      "benchmarks/scenarios/rerank-product.ts",
      "benchmarks/scenarios/rerank-supplemental.ts",
      "rust/solver-rs/src/cvar.rs",
      "rust/solver-rs/src/lib.rs",
      "src/solver/domain.ts",
      "src/wasm/rustCoreExports.ts",
      "src/wasm/rustLoader.ts",
      "src/wasm/rustProductInput.ts",
      "src/wasm/rustProductView.ts",
    ],
    wasmPath: PRODUCT_WASM_PATH,
  });
  assertResearchReportCanBeWritten(await readExistingReport(), provenance);
  const wasm = await readFile(new URL(`../${PRODUCT_WASM_PATH}`, import.meta.url));
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "error",
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });

  try {
    const loader = (await server.ssrLoadModule(
      "/src/wasm/rustLoader.ts",
    )) as typeof import("../src/wasm/rustLoader");
    const policyModule = (await server.ssrLoadModule(
      "/benchmarks/recorded-cvar-policy.ts",
    )) as typeof import("./recorded-cvar-policy");
    const fixed = (await server.ssrLoadModule(
      "/benchmarks/scenarios/fixed-grid.ts",
    )) as typeof import("./scenarios/fixed-grid");
    const product = (await server.ssrLoadModule(
      "/benchmarks/scenarios/rerank-product.ts",
    )) as typeof import("./scenarios/rerank-product");
    const supplemental = (await server.ssrLoadModule(
      "/benchmarks/scenarios/rerank-supplemental.ts",
    )) as typeof import("./scenarios/rerank-supplemental");
    const scenarios = [
      ...fixed.FIXED_SAFETY_GRID,
      ...product.PRODUCT_RERANK_SCENARIOS,
      ...supplemental.RERANK_SUPPLEMENTAL_SCENARIOS,
    ];
    const exports = loader.rustCoreExportsFromInstance(await instantiate(wasm));
    const records: Report["records"] = [];

    for (const scenario of scenarios) {
      const solver = policyModule.createRecordedCvarPolicySolver(exports, CONTRACT);
      const startedAt = performance.now();
      try {
        solver.solve({ start: scenario.start, stock: scenario.stock, strategy: "supply" });
        const decision = solver.decisions.at(-1);
        if (!decision) throw new Error("Recorded CVaR solver returned no decision record.");
        records.push({
          scenarioId: scenario.id,
          elapsedMs: performance.now() - startedAt,
          outcome: "completed",
          errorMessage: null,
          decision,
        });
        if (decision.decisionChanged) {
          console.log(
            `${scenario.id}: ${decision.baselineAction}/${decision.baselineRunCount} -> ` +
              `${decision.firstAction}/${decision.runCount} eta=${decision.selectedEta}`,
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        records.push({
          scenarioId: scenario.id,
          elapsedMs: performance.now() - startedAt,
          outcome: "failure",
          errorMessage,
          decision: null,
        });
        console.log(`${scenario.id}: failure ${errorMessage}`);
      }
    }

    const decisionChanges = records
      .filter((record) => record.decision?.decisionChanged)
      .map((record) => record.scenarioId);
    const report: Report = {
      kind: "recorded-cvar-root-screen",
      version: 1,
      generatedAt: new Date().toISOString(),
      provenance,
      contract: CONTRACT,
      records,
      decision: {
        completed: records.filter((record) => record.outcome === "completed").length,
        failures: records.filter((record) => record.outcome === "failure").length,
        recordedPolicySelected: records.filter(
          (record) => record.decision?.selectedPolicy === "recorded_cvar",
        ).length,
        decisionChanges,
        exactInteractiveRequired: decisionChanges.length > 0,
        productAdoptionAuthorized: false,
      },
    };
    await writeFile(OUTPUT_URL, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report.decision));
  } finally {
    await server.close();
  }
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
