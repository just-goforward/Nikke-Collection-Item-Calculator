import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { RustCoreExports, RustMinEfRoot, RustPhase2Policy } from "../src/wasm/rustTypes";
import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  fingerprintResearchArtifact,
  type ResearchProvenance,
  sameResearchIdentity,
} from "./research-provenance.ts";
import type { RustPrioritizedSparsePiResult } from "./rust-prioritized-sparse-pi.ts";
import {
  SOLVER_PORTFOLIO_CONFIRMATION_SCENARIOS,
  SOLVER_PORTFOLIO_DISCOVERY_SCENARIOS,
  SOLVER_PORTFOLIO_SCENARIOS,
  type SolverPortfolioScenario,
} from "./scenarios/solver-portfolio.ts";
import {
  type PortfolioArm,
  type PortfolioOutcome,
  type PortfolioRootRecord,
  type PortfolioSemantic,
  preRegisteredExactRescueArm,
  SOLVER_PORTFOLIO_CONTRACT,
  shouldScreenPortfolioAlternatives,
} from "./solver-portfolio-study.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRODUCT_WASM_PATH = "public/solver_rs.wasm";
const BRANCH_BOUND_WASM_PATH = "output/solver_rs-branch-bound-audit.wasm";
const PRIORITIZED_WASM_PATH = "output/solver_rs-prioritized-sparse-pi.wasm";
const OUTPUT_URL = new URL("./results/solver-portfolio-study-v1.json", import.meta.url);
const SELF_PATH = fileURLToPath(import.meta.url);
const CHILD_MARKER = "SOLVER_PORTFOLIO_RECORD:";

type Cohort = "all" | "confirmation" | "discovery";
type Report = {
  kind: "solver-portfolio-study";
  version: 1;
  generatedAt: string;
  provenance: ResearchProvenance;
  artifacts: {
    product: ReturnType<typeof fingerprintResearchArtifact>;
    branchBound: ReturnType<typeof fingerprintResearchArtifact>;
    prioritized: ReturnType<typeof fingerprintResearchArtifact>;
  };
  contract: typeof SOLVER_PORTFOLIO_CONTRACT;
  options: {
    confirmationScenarioIds: string[];
    discoveryScenarioIds: string[];
  };
  records: PortfolioRootRecord[];
  summary: ReturnType<typeof summarize>;
  decisionScope: { productAdoptionAuthorized: false; researchOnly: true };
};

async function runParent() {
  const cohort = parseCohort(process.env["SOLVER_PORTFOLIO_COHORT"]);
  const selectedScenarios = scenariosForCohort(cohort);
  const provenance = collectResearchProvenance({
    repoRoot: REPO_ROOT,
    studyId: "solver-portfolio-study-v1",
    protocolVersion: 1,
    contract: SOLVER_PORTFOLIO_CONTRACT,
    sourceFiles: [
      "benchmarks/run-solver-portfolio-study.ts",
      "benchmarks/scenarios/solver-portfolio.ts",
      "benchmarks/solver-portfolio-study.ts",
      "benchmarks/research-provenance.ts",
      "benchmarks/rust-prioritized-sparse-pi.ts",
      "scripts/build-solver-wasm-branch-bound.ts",
      "scripts/build-solver-wasm-sparse-pi.ts",
      "rust/solver-rs/Cargo.toml",
      "rust/solver-rs/src/lib.rs",
      "rust/solver-rs/src/minef.rs",
      "rust/solver-rs/src/prioritized_sparse_pi.rs",
      "src/wasm/rustMinEfCore.ts",
      "src/wasm/rustPhase2Core.ts",
    ],
    wasmPath: BRANCH_BOUND_WASM_PATH,
  });
  const existing = await readReport();
  const canResume = existing ? sameResearchIdentity(existing.provenance, provenance) : false;
  if (existing && !canResume) {
    assertResearchReportCanBeWritten(existing, provenance);
  }
  const report =
    (canResume ? existing : null) ??
    createReport(provenance, {
      product: fingerprintResearchArtifact(REPO_ROOT, PRODUCT_WASM_PATH),
      branchBound: fingerprintResearchArtifact(REPO_ROOT, BRANCH_BOUND_WASM_PATH),
      prioritized: fingerprintResearchArtifact(REPO_ROOT, PRIORITIZED_WASM_PATH),
    });

  for (const scenario of selectedScenarios) {
    const baseline = await ensureRecord(report, scenario, "min-ef-tier21");
    if (!shouldScreenPortfolioAlternatives(baseline.outcome)) continue;

    await ensureRecord(report, scenario, "min-ef-tier22");
    await ensureRecord(report, scenario, "branch-bound-b2-tier22");
    await ensureRecord(report, scenario, "phase2-tier22");
    if (scenario.start.grade === "SR") {
      await ensureRecord(report, scenario, "bounded-prioritized-phase2");
    }
  }

  report.generatedAt = new Date().toISOString();
  report.summary = summarize(report.records, SOLVER_PORTFOLIO_SCENARIOS);
  await writeReport(report);
  console.log(
    JSON.stringify({ cohort, output: OUTPUT_URL.pathname, summary: report.summary }, null, 2),
  );
}

async function ensureRecord(
  report: Report,
  scenario: SolverPortfolioScenario,
  arm: PortfolioArm,
): Promise<PortfolioRootRecord> {
  const current = report.records.find(
    (record) => record.scenarioId === scenario.id && record.arm === arm,
  );
  if (current) return current;
  const record = runChild(arm, scenario);
  report.records.push(record);
  report.generatedAt = new Date().toISOString();
  report.summary = summarize(report.records, SOLVER_PORTFOLIO_SCENARIOS);
  await writeReport(report);
  console.log(
    `${scenario.cohort} ${scenario.id} ${arm}: ${record.outcome} ` +
      `${record.elapsedMs.toFixed(2)}ms nodes=${record.nodeCount ?? "n/a"}`,
  );
  return record;
}

function runChild(arm: PortfolioArm, scenario: SolverPortfolioScenario): PortfolioRootRecord {
  const encodedScenario = Buffer.from(JSON.stringify(scenario), "utf8").toString("base64url");
  const result = spawnSync(process.execPath, [SELF_PATH, "--child", arm, encodedScenario], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: SOLVER_PORTFOLIO_CONTRACT.childTimeoutMs,
  });
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
    return timeoutRecord(arm, scenario.id);
  }
  if (result.status !== 0) {
    throw new Error(
      `Portfolio child failed (${scenario.id}/${arm}):\n${result.stderr || result.stdout}`,
    );
  }
  const line = result.stdout.split(/\r?\n/u).find((entry) => entry.startsWith(CHILD_MARKER));
  if (!line) throw new Error(`Portfolio child returned no record:\n${result.stdout}`);
  return JSON.parse(line.slice(CHILD_MARKER.length)) as PortfolioRootRecord;
}

async function runChildProcess(arm: PortfolioArm, scenario: SolverPortfolioScenario) {
  const wasmPath =
    arm === "branch-bound-b2-tier22"
      ? BRANCH_BOUND_WASM_PATH
      : arm === "bounded-prioritized-phase2"
        ? PRIORITIZED_WASM_PATH
        : PRODUCT_WASM_PATH;
  const bytes = await readFile(resolve(REPO_ROOT, wasmPath));
  const instantiated = await WebAssembly.instantiate(bytes);
  const instance =
    instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "error",
    optimizeDeps: { noDiscovery: true },
    server: { hmr: false, middlewareMode: true },
  });
  const modules = await loadRuntimeModules(server);
  const exports = modules.loader.rustCoreExportsFromInstance(instance);
  const memory = requireMemory(instance.exports);
  const memoryBeforeBytes = memory.buffer.byteLength;
  const startedAt = performance.now();
  try {
    const result = solveArm(arm, scenario, exports, modules);
    writeChild({
      arm,
      elapsedMs: performance.now() - startedAt,
      errorMessage: null,
      memoryAfterBytes: memory.buffer.byteLength,
      memoryBeforeBytes,
      scenarioId: scenario.id,
      ...result,
    });
  } catch (error) {
    writeChild({
      arm,
      elapsedMs: performance.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      memoryAfterBytes: memory.buffer.byteLength,
      memoryBeforeBytes,
      nodeCount: nodeCount(exports),
      outcome: classifyError(error, modules.status),
      scenarioId: scenario.id,
      semantic: null,
    });
  } finally {
    await server.close();
  }
}

type RuntimeModules = Awaited<ReturnType<typeof loadRuntimeModules>>;

async function loadRuntimeModules(server: Awaited<ReturnType<typeof createServer>>) {
  const [loader, minEf, phase2, prioritized, status] = await Promise.all([
    server.ssrLoadModule("/src/wasm/rustLoader.ts") as Promise<
      typeof import("../src/wasm/rustLoader")
    >,
    server.ssrLoadModule("/src/wasm/rustMinEfCore.ts") as Promise<
      typeof import("../src/wasm/rustMinEfCore")
    >,
    server.ssrLoadModule("/src/wasm/rustPhase2Core.ts") as Promise<
      typeof import("../src/wasm/rustPhase2Core")
    >,
    server.ssrLoadModule("/benchmarks/rust-prioritized-sparse-pi.ts") as Promise<
      typeof import("./rust-prioritized-sparse-pi")
    >,
    server.ssrLoadModule("/src/wasm/rustStatus.ts") as Promise<
      typeof import("../src/wasm/rustStatus")
    >,
  ]);
  return { loader, minEf, phase2, prioritized, status };
}

function solveArm(
  arm: PortfolioArm,
  scenario: SolverPortfolioScenario,
  exports: RustCoreExports,
  modules: RuntimeModules,
): Pick<PortfolioRootRecord, "branchBound" | "nodeCount" | "outcome" | "prioritized" | "semantic"> {
  const input = { start: scenario.start, stock: scenario.stock, strategy: "supply" as const };
  if (arm === "phase2-tier22") {
    const solver = modules.phase2.createRustPhase2Solver(exports);
    solver.configureMemoTier(SOLVER_PORTFOLIO_CONTRACT.phase2Tier);
    const policy = solver.buildPolicy(
      scenario.start,
      scenario.stock,
      SOLVER_PORTFOLIO_CONTRACT.horizonFactor,
      SOLVER_PORTFOLIO_CONTRACT.normPower,
      SOLVER_PORTFOLIO_CONTRACT.tolerance,
    );
    return {
      nodeCount: policy.root.states,
      outcome: "completed",
      semantic: phase2Semantic(policy),
    };
  }
  if (arm === "bounded-prioritized-phase2") {
    const result = modules.prioritized.solveRustPrioritizedSparsePi(exports, input, {
      horizonFactor: SOLVER_PORTFOLIO_CONTRACT.horizonFactor,
      maxPasses: 4,
      maxStates: 1_200_000,
      maxUpdatesPerPass: 256,
      memoTier: SOLVER_PORTFOLIO_CONTRACT.phase2Tier,
      normPower: SOLVER_PORTFOLIO_CONTRACT.normPower,
      priorityMode: "max_path_probability",
      tolerance: SOLVER_PORTFOLIO_CONTRACT.tolerance,
    });
    const usable = result.outcome === "completed" || result.outcome === "iteration_budget_exceeded";
    return {
      nodeCount: result.scannedStates,
      outcome: usable ? "completed" : "failure",
      prioritized: prioritizedDetails(result),
      semantic: usable ? prioritizedSemantic(result) : null,
    };
  }

  const branchBoundExports =
    arm === "branch-bound-b2-tier22" ? requireBranchBoundExports(exports) : null;
  if (branchBoundExports) {
    branchBoundExports.configureMinEfBranchBoundSuccessMemo(SOLVER_PORTFOLIO_CONTRACT.rescueTier);
    if (
      branchBoundExports.configureMinEfBranchBoundPruning(
        SOLVER_PORTFOLIO_CONTRACT.branchBoundMode,
      ) !== 1
    ) {
      throw new Error("Branch-bound candidate rejected the pre-registered B2 mode.");
    }
  }
  const solver = modules.minEf.createRustMinEfSolver(exports);
  const tier =
    arm === "min-ef-tier21"
      ? SOLVER_PORTFOLIO_CONTRACT.minEfTier
      : SOLVER_PORTFOLIO_CONTRACT.rescueTier;
  solver.configureMemoTier(tier);
  exports.configureNodeBudget?.(
    arm === "min-ef-tier21" ? 2_000_000 : SOLVER_PORTFOLIO_CONTRACT.exactRescueNodeBudget,
  );
  const policy = solver.solveRootWithCandidates(
    scenario.start,
    scenario.stock,
    SOLVER_PORTFOLIO_CONTRACT.horizonFactor,
    SOLVER_PORTFOLIO_CONTRACT.normPower,
    SOLVER_PORTFOLIO_CONTRACT.tolerance,
  );
  return {
    ...(branchBoundExports
      ? {
          branchBound: {
            appliedPrunes: branchBoundExports.minEfBranchBoundAppliedPrunes(),
            oracleStates: branchBoundExports.minEfBranchBoundOracleStates(),
            prepassMismatches: branchBoundExports.minEfBranchBoundPrepassMismatches(),
          },
        }
      : {}),
    nodeCount: policy.nodeCount,
    outcome: "completed",
    semantic: minEfSemantic(policy.root),
  };
}

function minEfSemantic(root: RustMinEfRoot): PortfolioSemantic {
  return {
    action: root.firstAction,
    expectedCost: root.expectedCost,
    maxSuccessProbability: root.maxSuccessProbability,
    successProbability: root.successProbability,
    vector: { ...root.vector },
  };
}

function phase2Semantic(policy: RustPhase2Policy): PortfolioSemantic {
  const selected = policy.candidates.find(
    (candidate) => candidate.firstAction === policy.root.firstAction,
  );
  return {
    action: policy.root.firstAction,
    expectedCost: selected?.resourceCost ?? null,
    maxSuccessProbability: policy.root.maxSuccessProbability,
    successProbability: policy.root.successProbability,
    vector: { ...policy.root.vector },
  };
}

function prioritizedSemantic(result: RustPrioritizedSparsePiResult): PortfolioSemantic {
  return {
    action: result.finalAction,
    expectedCost: result.cost,
    maxSuccessProbability: result.success + result.probabilityGap,
    successProbability: result.success,
    vector: { ...result.vector },
  };
}

function prioritizedDetails(result: RustPrioritizedSparsePiResult) {
  return {
    outcome: result.outcome,
    overrides: result.overrides,
    passes: result.passes,
    peakStates: result.peakStates,
    probabilityGap: result.probabilityGap,
    successInvariantMaxGap: result.successInvariantMaxGap,
  };
}

type BranchBoundResearchFunctions = {
  configureMinEfBranchBoundPruning: (mode: number) => number;
  configureMinEfBranchBoundSuccessMemo: (tier: number) => void;
  minEfBranchBoundAppliedPrunes: () => number;
  minEfBranchBoundOracleStates: () => number;
  minEfBranchBoundPrepassMismatches: () => number;
};

type BranchBoundResearchExports = RustCoreExports & BranchBoundResearchFunctions;

function requireBranchBoundExports(exports: RustCoreExports): BranchBoundResearchExports {
  const research = exports as RustCoreExports & Partial<BranchBoundResearchFunctions>;
  if (
    typeof research.configureMinEfBranchBoundPruning !== "function" ||
    typeof research.configureMinEfBranchBoundSuccessMemo !== "function" ||
    typeof research.minEfBranchBoundAppliedPrunes !== "function" ||
    typeof research.minEfBranchBoundOracleStates !== "function" ||
    typeof research.minEfBranchBoundPrepassMismatches !== "function"
  ) {
    throw new Error("Missing branch-bound research exports.");
  }
  return research as BranchBoundResearchExports;
}

function nodeCount(exports: RustCoreExports): number | null {
  return exports.minEfNodeCount?.() ?? exports.statesCount?.() ?? null;
}

function classifyError(
  error: unknown,
  status: typeof import("../src/wasm/rustStatus"),
): PortfolioOutcome {
  if (error instanceof status.RustSolveError) {
    if (error.status === status.RUST_STATUS_MEMO_FULL) return "memo_full";
    if (error.status === status.RUST_STATUS_BUDGET_EXCEEDED) return "budget_exceeded";
  }
  return "failure";
}

function requireMemory(exports: WebAssembly.Exports): WebAssembly.Memory {
  const memory = exports["memory"];
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("WASM memory export is missing.");
  return memory;
}

function writeChild(record: PortfolioRootRecord) {
  process.stdout.write(`${CHILD_MARKER}${JSON.stringify(record)}\n`);
}

function timeoutRecord(arm: PortfolioArm, scenarioId: string): PortfolioRootRecord {
  return {
    arm,
    elapsedMs: SOLVER_PORTFOLIO_CONTRACT.childTimeoutMs,
    errorMessage: `Child exceeded ${SOLVER_PORTFOLIO_CONTRACT.childTimeoutMs}ms.`,
    memoryAfterBytes: 0,
    memoryBeforeBytes: 0,
    nodeCount: null,
    outcome: "timeout",
    scenarioId,
    semantic: null,
  };
}

function summarize(records: PortfolioRootRecord[], scenarios: readonly SolverPortfolioScenario[]) {
  const cohortById = new Map(scenarios.map((scenario) => [scenario.id, scenario.cohort]));
  const cohorts = ["discovery", "confirmation"] as const;
  return Object.fromEntries(
    cohorts.map((cohort) => {
      const cohortRecords = records.filter(
        (record) => cohortById.get(record.scenarioId) === cohort,
      );
      const baseline = cohortRecords.filter((record) => record.arm === "min-ef-tier21");
      const fallbackIds = new Set(
        baseline
          .filter((record) => shouldScreenPortfolioAlternatives(record.outcome))
          .map((record) => record.scenarioId),
      );
      const armOutcomes = Object.fromEntries(
        [
          "min-ef-tier21",
          "min-ef-tier22",
          "branch-bound-b2-tier22",
          "phase2-tier22",
          "bounded-prioritized-phase2",
        ].map((arm) => {
          const armRecords = cohortRecords.filter((record) => record.arm === arm);
          return [
            arm,
            Object.fromEntries(
              ["completed", "memo_full", "budget_exceeded", "timeout", "failure"].map((outcome) => [
                outcome,
                armRecords.filter((record) => record.outcome === outcome).length,
              ]),
            ),
          ];
        }),
      );
      const preRegisteredRescues = [...fallbackIds].filter((scenarioId) => {
        const scenario = scenarios.find((entry) => entry.id === scenarioId);
        if (!scenario) return false;
        const arm = preRegisteredExactRescueArm({ start: scenario.start });
        return cohortRecords.some(
          (record) =>
            record.scenarioId === scenarioId &&
            record.arm === arm &&
            record.outcome === "completed",
        );
      }).length;
      return [
        cohort,
        {
          alternativeScreenComplete: [...fallbackIds].every((scenarioId) =>
            cohortRecords.some(
              (record) => record.scenarioId === scenarioId && record.arm === "phase2-tier22",
            ),
          ),
          armOutcomes,
          baselineRecords: baseline.length,
          fallbackRecords: fallbackIds.size,
          preRegisteredExactRescues: preRegisteredRescues,
        },
      ];
    }),
  );
}

function createReport(provenance: ResearchProvenance, artifacts: Report["artifacts"]): Report {
  return {
    kind: "solver-portfolio-study",
    version: 1,
    generatedAt: new Date().toISOString(),
    provenance,
    artifacts,
    contract: SOLVER_PORTFOLIO_CONTRACT,
    options: {
      confirmationScenarioIds: SOLVER_PORTFOLIO_CONFIRMATION_SCENARIOS.map(({ id }) => id),
      discoveryScenarioIds: SOLVER_PORTFOLIO_DISCOVERY_SCENARIOS.map(({ id }) => id),
    },
    records: [],
    summary: summarize([], SOLVER_PORTFOLIO_SCENARIOS),
    decisionScope: { productAdoptionAuthorized: false, researchOnly: true },
  };
}

async function readReport(): Promise<Report | null> {
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

async function writeReport(report: Report) {
  await writeFile(OUTPUT_URL, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function parseCohort(value: string | undefined): Cohort {
  if (!value || value === "all") return "all";
  if (value === "discovery" || value === "confirmation") return value;
  throw new Error("SOLVER_PORTFOLIO_COHORT must be discovery, confirmation, or all.");
}

function scenariosForCohort(cohort: Cohort): SolverPortfolioScenario[] {
  if (cohort === "discovery") return SOLVER_PORTFOLIO_DISCOVERY_SCENARIOS;
  if (cohort === "confirmation") return SOLVER_PORTFOLIO_CONFIRMATION_SCENARIOS;
  return SOLVER_PORTFOLIO_SCENARIOS;
}

function isPortfolioArm(value: string | undefined): value is PortfolioArm {
  return (
    value === "min-ef-tier21" ||
    SOLVER_PORTFOLIO_CONTRACT.candidateArms.some((candidate) => candidate === value)
  );
}

const mode = process.argv[2];
if (mode === "--child") {
  const arm = process.argv[3];
  const encodedScenario = process.argv[4];
  if (!isPortfolioArm(arm)) {
    throw new Error("Invalid portfolio child arm.");
  }
  if (!encodedScenario) throw new Error("Missing portfolio child scenario.");
  const scenario = JSON.parse(
    Buffer.from(encodedScenario, "base64url").toString("utf8"),
  ) as SolverPortfolioScenario;
  await runChildProcess(arm, scenario);
} else {
  await runParent();
}
