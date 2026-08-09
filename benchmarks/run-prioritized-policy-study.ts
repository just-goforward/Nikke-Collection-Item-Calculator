import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  fingerprintResearchArtifact,
  type ResearchProvenance,
} from "./research-provenance.ts";
import type { SolverScenario } from "./scenarios/fixed-grid";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRODUCT_WASM_PATH = "public/solver_rs.wasm";
const CANDIDATE_WASM_PATH = "output/solver_rs-prioritized-sparse-pi.wasm";
const OUTPUT_URL = new URL("./results/prioritized-policy-study-v4.json", import.meta.url);
const EPSILON = 1e-12;
const SEMANTIC_SCENARIOS = [
  "R0-semantic-60-120-900",
  "R14e900-yellow30",
  "SR5-blue30",
  "SR10-yellow10",
] as const;
const SCREEN_SCENARIOS = ["R0-semantic-60-120-900", "R10-balanced300", "SR0-balanced300"] as const;
const PRIORITY_MODES = ["discovery_order", "max_path_probability"] as const;
const CONTRACT = {
  objective: "test_priority_order_under_equal_bounded_update_budget",
  exact: {
    maxPasses: 80,
    maxStates: 1_200_000,
    maxUpdatesPerPass: 1_000_000,
    priorityMode: "max_path_probability",
  },
  boundedScreen: {
    maxPasses: 4,
    maxStates: 1_200_000,
    maxUpdatesPerPass: 256,
    priorityModes: PRIORITY_MODES,
  },
  horizonFactor: 0.75,
  normPower: 3,
  tolerance: 0,
  parityTolerance: { success: 1e-12, cost: 1e-12, vector: 1e-9 },
  winnerRule:
    "one_mode_weakly_dominates_cost_at_success_parity_on_all_screens_and_strictly_improves_one",
} as const;

type CandidateModule = typeof import("./rust-prioritized-sparse-pi");
type CandidateResult = ReturnType<CandidateModule["solveRustPrioritizedSparsePi"]>;
type MinEfRoot = ReturnType<
  ReturnType<
    typeof import("../src/wasm/rustMinEfCore")["createRustMinEfSolver"]
  >["solveRootWithCandidates"]
>["root"];
type Phase2Root = ReturnType<
  ReturnType<
    typeof import("../src/wasm/rustPhase2ResearchCore")["createRustPhase2ResearchSolver"]
  >["solveRoot"]
>;

type Report = {
  kind: "prioritized-policy-study";
  version: 4;
  generatedAt: string;
  provenance: ResearchProvenance;
  productWasm: ReturnType<typeof fingerprintResearchArtifact>;
  contract: typeof CONTRACT;
  exactRecords: Array<{
    scenarioId: string;
    candidate: CandidateResult;
    reference: MinEfRoot | null;
    parity: ReturnType<typeof compareToMinEf> | null;
    closureComplete: boolean;
    successInvariantVerified: boolean;
  }>;
  priorityRecords: Array<{
    scenarioId: string;
    phase2Root: Phase2Root;
    candidates: Record<(typeof PRIORITY_MODES)[number], CandidateResult>;
    comparison: ReturnType<typeof comparePriorityModes>;
  }>;
  decision: {
    exactGatePassed: boolean;
    capacityBoundaryConfirmed: boolean;
    priorityWinner: (typeof PRIORITY_MODES)[number] | "none";
    blockers: string[];
  };
};

async function main() {
  const provenance = collectResearchProvenance({
    repoRoot: REPO_ROOT,
    studyId: "prioritized-policy-study-v4",
    protocolVersion: 4,
    contract: CONTRACT,
    sourceFiles: [
      "benchmarks/run-prioritized-policy-study.ts",
      "benchmarks/research-provenance.ts",
      "benchmarks/rust-prioritized-sparse-pi.ts",
      "benchmarks/scenarios/fixed-grid.ts",
      "rust/solver-rs/src/prioritized_sparse_pi.rs",
      "src/solver/domain.ts",
      "src/wasm/rustCoreExports.ts",
      "src/wasm/rustLoader.ts",
      "src/wasm/rustMinEfCore.ts",
      "src/wasm/rustPhase2ResearchCore.ts",
    ],
    wasmPath: CANDIDATE_WASM_PATH,
  });
  assertResearchReportCanBeWritten(await readExistingReport(), provenance);

  const [candidateWasm, productWasm] = await Promise.all([
    readFile(new URL(`../${CANDIDATE_WASM_PATH}`, import.meta.url)),
    readFile(new URL(`../${PRODUCT_WASM_PATH}`, import.meta.url)),
  ]);
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
    const phase2Module = (await server.ssrLoadModule(
      "/src/wasm/rustPhase2ResearchCore.ts",
    )) as typeof import("../src/wasm/rustPhase2ResearchCore");
    const candidateModule = (await server.ssrLoadModule(
      "/benchmarks/rust-prioritized-sparse-pi.ts",
    )) as CandidateModule;
    const fixed = (await server.ssrLoadModule(
      "/benchmarks/scenarios/fixed-grid.ts",
    )) as typeof import("./scenarios/fixed-grid");
    const byId = new Map(fixed.FIXED_SAFETY_GRID.map((scenario) => [scenario.id, scenario]));
    const custom = semanticR0();
    const scenario = (id: string) => (id === custom.id ? custom : requiredScenario(byId, id));
    const blockers: string[] = [];

    const exactRecords: Report["exactRecords"] = [];
    for (const id of [...SEMANTIC_SCENARIOS, "R10-balanced300"] as const) {
      const fixture = scenario(id);
      const candidate = candidateModule.solveRustPrioritizedSparsePi(
        loader.rustCoreExportsFromInstance(await instantiate(candidateWasm)),
        input(fixture),
        { ...CONTRACT.exact, memoTier: 22, tolerance: 0 },
      );
      const closureComplete =
        candidate.outcome !== "completed" ||
        candidate.finalPassStates === candidate.finalPassScanned;
      const successInvariantVerified =
        candidate.successInvariantChecks > 0 && candidate.successInvariantMaxGap <= EPSILON;
      let reference: MinEfRoot | null = null;
      let parity: ReturnType<typeof compareToMinEf> | null = null;
      if ((SEMANTIC_SCENARIOS as readonly string[]).includes(id)) {
        reference = minEfModule
          .createRustMinEfSolver(loader.rustCoreExportsFromInstance(await instantiate(productWasm)))
          .solveRootWithCandidates(fixture.start, fixture.stock, 0.75, 3, 0).root;
        parity = compareToMinEf(candidate, reference);
        if (!parity.passed) blockers.push(`${id}: min-E[f] parity failed`);
        if (!closureComplete) blockers.push(`${id}: completed pass did not exhaust closure`);
        if (!successInvariantVerified) blockers.push(`${id}: tau=0 success invariant failed`);
      } else if (candidate.outcome !== "state_budget_exceeded") {
        blockers.push(`${id}: expected state_budget_exceeded, got ${candidate.outcome}`);
      }
      exactRecords.push({
        scenarioId: id,
        candidate,
        reference,
        parity,
        closureComplete,
        successInvariantVerified,
      });
      console.log(
        `exact ${id}: ${candidate.outcome} states=${candidate.peakStates} ` +
          `scanned=${candidate.finalPassScanned}/${candidate.finalPassStates}`,
      );
    }

    const priorityRecords: Report["priorityRecords"] = [];
    for (const id of SCREEN_SCENARIOS) {
      const fixture = scenario(id);
      const phase2 = phase2Module.createRustPhase2ResearchSolver(
        loader.rustCoreExportsFromInstance(await instantiate(productWasm)),
      );
      phase2.configureMemoTier(22);
      const phase2Root = phase2.solveRoot(fixture.start, fixture.stock, 0.75, 3, 0);
      const candidates = {} as Record<(typeof PRIORITY_MODES)[number], CandidateResult>;
      for (const priorityMode of PRIORITY_MODES) {
        candidates[priorityMode] = candidateModule.solveRustPrioritizedSparsePi(
          loader.rustCoreExportsFromInstance(await instantiate(candidateWasm)),
          input(fixture),
          { ...CONTRACT.boundedScreen, memoTier: 22, priorityMode, tolerance: 0 },
        );
      }
      const comparison = comparePriorityModes(candidates);
      priorityRecords.push({ scenarioId: id, phase2Root, candidates, comparison });
      console.log(
        `priority ${id}: discovery=${candidates.discovery_order.cost} ` +
          `max-path=${candidates.max_path_probability.cost} verdict=${comparison.verdict}`,
      );
    }

    const priorityWinner = selectPriorityWinner(priorityRecords);
    const report: Report = {
      kind: "prioritized-policy-study",
      version: 4,
      generatedAt: new Date().toISOString(),
      provenance,
      productWasm: fingerprintResearchArtifact(REPO_ROOT, PRODUCT_WASM_PATH),
      contract: CONTRACT,
      exactRecords,
      priorityRecords,
      decision: {
        exactGatePassed: blockers.length === 0,
        capacityBoundaryConfirmed:
          exactRecords.find((record) => record.scenarioId === "R10-balanced300")?.candidate
            .outcome === "state_budget_exceeded",
        priorityWinner,
        blockers,
      },
    };
    await writeFile(OUTPUT_URL, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report.decision));
  } finally {
    await server.close();
  }
}

function compareToMinEf(candidate: CandidateResult, reference: MinEfRoot) {
  const deltas = {
    success: candidate.success - reference.successProbability,
    cost: candidate.cost - reference.expectedCost,
    blue: candidate.vector.blue - reference.vector.blue,
    purple: candidate.vector.purple - reference.vector.purple,
    yellow: candidate.vector.yellow - reference.vector.yellow,
  };
  return {
    actionEqual: candidate.finalAction === reference.firstAction,
    deltas,
    passed:
      candidate.outcome === "completed" &&
      candidate.finalAction === reference.firstAction &&
      Math.abs(deltas.success) <= CONTRACT.parityTolerance.success &&
      Math.abs(deltas.cost) <= CONTRACT.parityTolerance.cost &&
      Math.abs(deltas.blue) <= CONTRACT.parityTolerance.vector &&
      Math.abs(deltas.purple) <= CONTRACT.parityTolerance.vector &&
      Math.abs(deltas.yellow) <= CONTRACT.parityTolerance.vector &&
      candidate.probabilityGap <= CONTRACT.parityTolerance.success,
  };
}

function comparePriorityModes(
  candidates: Record<(typeof PRIORITY_MODES)[number], CandidateResult>,
) {
  const discovery = candidates.discovery_order;
  const maxPath = candidates.max_path_probability;
  const initialCostDelta = maxPath.initialCost - discovery.initialCost;
  const successDelta = maxPath.success - discovery.success;
  const costDelta = maxPath.cost - discovery.cost;
  const valid =
    [discovery, maxPath].every(
      (candidate) =>
        candidate.outcome === "iteration_budget_exceeded" &&
        candidate.probabilityGap <= EPSILON &&
        candidate.success >= candidate.initialSuccess - EPSILON &&
        candidate.cost <= candidate.initialCost + EPSILON &&
        candidate.successInvariantChecks > 0 &&
        candidate.successInvariantMaxGap <= EPSILON,
    ) && Math.abs(initialCostDelta) <= EPSILON;
  const verdict = !valid
    ? "invalid"
    : successDelta < -EPSILON
      ? "discovery_order"
      : successDelta > EPSILON
        ? "max_path_probability"
        : costDelta < -EPSILON
          ? "max_path_probability"
          : costDelta > EPSILON
            ? "discovery_order"
            : "tie";
  return {
    valid,
    initialCostDelta,
    discoveryImprovement: discovery.cost - discovery.initialCost,
    maxPathImprovement: maxPath.cost - maxPath.initialCost,
    successDelta,
    costDelta,
    verdict,
  };
}

function selectPriorityWinner(
  records: Report["priorityRecords"],
): Report["decision"]["priorityWinner"] {
  if (records.some((record) => !record.comparison.valid)) return "none";
  const verdicts = records.map((record) => record.comparison.verdict);
  for (const mode of PRIORITY_MODES) {
    if (
      verdicts.every((verdict) => verdict === mode || verdict === "tie") &&
      verdicts.includes(mode)
    ) {
      return mode;
    }
  }
  return "none";
}

function semanticR0(): SolverScenario {
  return {
    id: "R0-semantic-60-120-900",
    group: "scarcity",
    start: { grade: "R", level: 0, exp: 0 },
    stock: { blue: 60, purple: 120, yellow: 900 },
  };
}

function requiredScenario(byId: ReadonlyMap<string, SolverScenario>, id: string): SolverScenario {
  const value = byId.get(id);
  if (!value) throw new Error(`Missing prioritized-policy scenario: ${id}.`);
  return value;
}

function input(scenario: SolverScenario) {
  return { start: scenario.start, stock: scenario.stock, strategy: "supply" as const };
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
