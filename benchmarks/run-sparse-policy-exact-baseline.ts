import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  type ResearchProvenance,
} from "./research-provenance.ts";
import type { SolverScenario } from "./scenarios/fixed-grid";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WASM_PATH = "public/solver_rs.wasm";
const OUTPUT_URL = new URL("./results/sparse-policy-exact-baseline-v2.json", import.meta.url);

const SEMANTIC_SCENARIOS = [
  "R0-semantic-60-120-900",
  "R14e900-yellow30",
  "SR5-blue30",
  "SR10-yellow10",
] as const;
const CAPACITY_SCENARIO = "R10-balanced300";
const CONTRACT = {
  candidate: "saturated-eligible-closure-sparse-policy-iteration",
  horizonFactor: 0.75,
  normPower: 3,
  tolerance: 0,
  successInvariant: "tau0_policy_success_equals_phase2_action_maximum",
  maxIterations: 40,
  maxStates: 1_200_000,
  timeBudgetMs: 120_000,
  memoTier: 22,
  semanticScenarios: SEMANTIC_SCENARIOS,
  capacityScenario: CAPACITY_SCENARIO,
  parityTolerance: { success: 1e-12, cost: 1e-12, vector: 1e-9 },
} as const;

type SparseResult = ReturnType<
  typeof import("./sparse-policy-iteration")["solveSparsePolicyIteration"]
>;
type MinEfRoot = ReturnType<
  ReturnType<
    typeof import("../src/wasm/rustMinEfCore")["createRustMinEfSolver"]
  >["solveRootWithCandidates"]
>["root"];

type Report = {
  kind: "sparse-policy-exact-baseline";
  version: 2;
  generatedAt: string;
  provenance: ResearchProvenance;
  contract: typeof CONTRACT;
  records: Array<{
    scenarioId: string;
    sparse: SparseResult;
    minEf: MinEfRoot | null;
    parity: ReturnType<typeof compareToMinEf> | null;
    closureStable: boolean;
    successInvariantVerified: boolean;
  }>;
  gate: { passed: boolean; blockers: string[] };
};

async function main() {
  const provenance = collectResearchProvenance({
    repoRoot: REPO_ROOT,
    studyId: "sparse-policy-exact-baseline-v2",
    protocolVersion: 2,
    contract: CONTRACT,
    sourceFiles: [
      "benchmarks/run-sparse-policy-exact-baseline.ts",
      "benchmarks/research-provenance.ts",
      "benchmarks/sparse-policy-iteration.ts",
      "benchmarks/scenarios/fixed-grid.ts",
      "src/solver/domain.ts",
      "src/wasm/rustCoreShared.ts",
      "src/wasm/rustLoader.ts",
      "src/wasm/rustMinEfCore.ts",
    ],
    wasmPath: WASM_PATH,
  });
  assertResearchReportCanBeWritten(await readExistingReport(), provenance);

  const wasm = await readFile(new URL(`../${WASM_PATH}`, import.meta.url));
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
    const minEfModule = (await server.ssrLoadModule(
      "/src/wasm/rustMinEfCore.ts",
    )) as typeof import("../src/wasm/rustMinEfCore");
    const sparseModule = (await server.ssrLoadModule(
      "/benchmarks/sparse-policy-iteration.ts",
    )) as typeof import("./sparse-policy-iteration");
    const fixed = (await server.ssrLoadModule(
      "/benchmarks/scenarios/fixed-grid.ts",
    )) as typeof import("./scenarios/fixed-grid");
    const byId = new Map(fixed.FIXED_SAFETY_GRID.map((scenario) => [scenario.id, scenario]));
    const scenarios: SolverScenario[] = [
      {
        id: "R0-semantic-60-120-900",
        group: "scarcity",
        start: { grade: "R", level: 0, exp: 0 },
        stock: { blue: 60, purple: 120, yellow: 900 },
      },
      ...SEMANTIC_SCENARIOS.slice(1).map((id) => requiredScenario(byId, id)),
      requiredScenario(byId, CAPACITY_SCENARIO),
    ];

    const records: Report["records"] = [];
    const blockers: string[] = [];
    for (const scenario of scenarios) {
      const sparseExports = loader.rustCoreExportsFromInstance(await instantiate(wasm));
      const sparse = sparseModule.solveSparsePolicyIteration(
        sparseExports,
        { start: scenario.start, stock: scenario.stock, strategy: "supply" },
        {
          horizonFactor: CONTRACT.horizonFactor,
          maxIterations: CONTRACT.maxIterations,
          maxStates: CONTRACT.maxStates,
          memoTier: CONTRACT.memoTier,
          normPower: CONTRACT.normPower,
          timeBudgetMs: CONTRACT.timeBudgetMs,
          tolerance: CONTRACT.tolerance,
        },
      );
      const closureStable = sparse.iterations.every(
        (iteration) =>
          iteration.closureStates === sparse.closureStates &&
          iteration.improvementStates === iteration.closureStates &&
          iteration.evaluatedStates === iteration.closureStates,
      );
      const successInvariantVerified = sparse.iterations.every(
        (iteration) => iteration.successInvariantChecks > 0,
      );
      let minEf: MinEfRoot | null = null;
      let parity: ReturnType<typeof compareToMinEf> | null = null;
      if ((SEMANTIC_SCENARIOS as readonly string[]).includes(scenario.id)) {
        minEf = minEfModule
          .createRustMinEfSolver(loader.rustCoreExportsFromInstance(await instantiate(wasm)))
          .solveRootWithCandidates(
            scenario.start,
            scenario.stock,
            CONTRACT.horizonFactor,
            CONTRACT.normPower,
            CONTRACT.tolerance,
          ).root;
        parity = compareToMinEf(sparse, minEf);
        if (sparse.outcome !== "completed") {
          blockers.push(`${scenario.id}: sparse outcome ${sparse.outcome}`);
        }
        if (!parity.passed) blockers.push(`${scenario.id}: min-E[f] parity failed`);
        if (!closureStable) blockers.push(`${scenario.id}: closure was not fully scanned`);
        if (!successInvariantVerified) {
          blockers.push(`${scenario.id}: tau=0 success invariant was not exercised`);
        }
      } else if (sparse.outcome !== "state_budget_exceeded") {
        blockers.push(`${scenario.id}: expected state_budget_exceeded, got ${sparse.outcome}`);
      }
      records.push({
        scenarioId: scenario.id,
        sparse,
        minEf,
        parity,
        closureStable,
        successInvariantVerified,
      });
      console.log(
        `${scenario.id}: ${sparse.outcome} closure=${sparse.closureStates} iterations=${sparse.iterations.length} parity=${parity?.passed ?? "n/a"}`,
      );
    }

    const report: Report = {
      kind: "sparse-policy-exact-baseline",
      version: 2,
      generatedAt: new Date().toISOString(),
      provenance,
      contract: CONTRACT,
      records,
      gate: { passed: blockers.length === 0, blockers },
    };
    await writeFile(OUTPUT_URL, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report.gate));
  } finally {
    await server.close();
  }
}

function requiredScenario(byId: ReadonlyMap<string, SolverScenario>, id: string): SolverScenario {
  const scenario = byId.get(id);
  if (!scenario) throw new Error(`Missing exact sparse PI scenario: ${id}.`);
  return scenario;
}

async function instantiate(wasm: Uint8Array): Promise<WebAssembly.Instance> {
  const result = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  return result instanceof WebAssembly.Instance ? result : result.instance;
}

function compareToMinEf(sparse: SparseResult, minEf: MinEfRoot) {
  const successDelta = (sparse.finalValue?.success ?? Number.NaN) - minEf.successProbability;
  const maximumSuccessDelta =
    (sparse.finalValue?.success ?? Number.NaN) +
    sparse.probabilityGap -
    minEf.maxSuccessProbability;
  const costDelta = (sparse.finalValue?.cost ?? Number.NaN) - minEf.expectedCost;
  const vectorDelta = [
    (sparse.finalValue?.vector[0] ?? Number.NaN) - minEf.vector.blue,
    (sparse.finalValue?.vector[1] ?? Number.NaN) - minEf.vector.purple,
    (sparse.finalValue?.vector[2] ?? Number.NaN) - minEf.vector.yellow,
  ] as const;
  return {
    actionEqual: sparse.finalAction === minEf.firstAction,
    successDelta,
    maximumSuccessDelta,
    costDelta,
    vectorDelta,
    passed:
      sparse.outcome === "completed" &&
      sparse.finalAction === minEf.firstAction &&
      Math.abs(successDelta) <= CONTRACT.parityTolerance.success &&
      Math.abs(maximumSuccessDelta) <= CONTRACT.parityTolerance.success &&
      Math.abs(costDelta) <= CONTRACT.parityTolerance.cost &&
      vectorDelta.every((value) => Math.abs(value) <= CONTRACT.parityTolerance.vector),
  };
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
