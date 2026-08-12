import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { ExactPolicySolverResult } from "./evaluator/exact-replan-types";
import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  fingerprintResearchArtifact,
  type ResearchProvenance,
  sameResearchIdentity,
} from "./research-provenance.ts";
import { SOLVER_PORTFOLIO_ROUTING_VALIDATION_SCENARIOS } from "./scenarios/solver-portfolio-validation.ts";
import type {
  SolverPortfolioRouteMode,
  SolverPortfolioRouteTrace,
} from "./solver-portfolio-routing.ts";
import {
  CONDITIONAL_EXACT_RESCUE_RULE,
  conditionalExactRescueEligible,
  portfolioRouteLatencyPassed,
  SOLVER_PORTFOLIO_ROUTING_CONTRACT,
} from "./solver-portfolio-routing-contract.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRODUCT_WASM_PATH = "public/solver_rs.wasm";
const BRANCH_BOUND_WASM_PATH = "output/solver_rs-branch-bound-audit.wasm";
const OUTPUT_URL = new URL(
  "./results/solver-portfolio-routing-validation-v1.json",
  import.meta.url,
);
const SELF_PATH = fileURLToPath(import.meta.url);
const CHILD_MARKER = "SOLVER_PORTFOLIO_ROUTING_RECORD:";
const CHILD_TIMEOUT_MS = 30_000;
const MODES = [
  "baseline",
  "conditional-min-ef-tier22",
  "direct-conditional-min-ef-tier22",
  "branch-bound-b2-on-capacity",
] as const;

type ValidationMode = (typeof MODES)[number];
type ValidationRecord = {
  decision: ExactPolicySolverResult | null;
  elapsedMs: number;
  errorMessage: string | null;
  memoryAfterBytes: number;
  memoryBeforeBytes: number;
  mode: ValidationMode;
  scenarioId: string;
  trace: SolverPortfolioRouteTrace | null;
};

type Report = {
  kind: "solver-portfolio-routing-validation";
  version: 1;
  generatedAt: string;
  provenance: ResearchProvenance;
  artifacts: {
    product: ReturnType<typeof fingerprintResearchArtifact>;
    branchBound: ReturnType<typeof fingerprintResearchArtifact>;
  };
  contract: typeof SOLVER_PORTFOLIO_ROUTING_CONTRACT;
  validationRule: typeof CONDITIONAL_EXACT_RESCUE_RULE;
  options: { scenarioIds: string[]; childTimeoutMs: number };
  records: ValidationRecord[];
  summary: ReturnType<typeof summarize>;
  decisionScope: { productAdoptionAuthorized: false; researchOnly: true };
};

async function runParent() {
  const provenance = collectResearchProvenance({
    repoRoot: REPO_ROOT,
    studyId: "solver-portfolio-routing-validation-v1",
    protocolVersion: 1,
    contract: SOLVER_PORTFOLIO_ROUTING_CONTRACT,
    sourceFiles: [
      "benchmarks/research-provenance.ts",
      "benchmarks/run-solver-portfolio-routing-validation.ts",
      "benchmarks/scenarios/solver-portfolio-validation.ts",
      "benchmarks/solver-portfolio-routing-contract.ts",
      "benchmarks/solver-portfolio-routing.ts",
      "rust/solver-rs/src/minef.rs",
      "scripts/build-solver-wasm-branch-bound.ts",
      "src/wasm/rustMinEfCore.ts",
      "src/wasm/rustPhase2Core.ts",
      "src/wasm/rustProductInput.ts",
      "src/wasm/rustProductView.ts",
    ],
    wasmPath: BRANCH_BOUND_WASM_PATH,
  });
  const existing = await readReport();
  const canResume = existing ? sameResearchIdentity(existing.provenance, provenance) : false;
  if (existing && !canResume) assertResearchReportCanBeWritten(existing, provenance);
  const report = canResume && existing ? existing : createReport(provenance);

  for (const scenario of SOLVER_PORTFOLIO_ROUTING_VALIDATION_SCENARIOS) {
    for (const mode of MODES) {
      if (
        report.records.some((record) => record.scenarioId === scenario.id && record.mode === mode)
      ) {
        continue;
      }
      const record = runChild(mode, scenario);
      report.records.push(record);
      report.generatedAt = new Date().toISOString();
      report.summary = summarize(report.records);
      await writeReport(report);
      console.log(
        `${scenario.id} ${mode}: ${record.trace?.selectedBackend ?? "failure"} ` +
          `${record.elapsedMs.toFixed(2)}ms`,
      );
    }
  }
  report.generatedAt = new Date().toISOString();
  report.summary = summarize(report.records);
  await writeReport(report);
  console.log(JSON.stringify({ output: OUTPUT_URL.pathname, summary: report.summary }, null, 2));
}

function runChild(
  mode: ValidationMode,
  scenario: (typeof SOLVER_PORTFOLIO_ROUTING_VALIDATION_SCENARIOS)[number],
): ValidationRecord {
  const encoded = Buffer.from(JSON.stringify(scenario), "utf8").toString("base64url");
  const child = spawnSync(process.execPath, [SELF_PATH, "--child", mode, encoded], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: CHILD_TIMEOUT_MS,
  });
  if (child.error && "code" in child.error && child.error.code === "ETIMEDOUT") {
    return {
      decision: null,
      elapsedMs: CHILD_TIMEOUT_MS,
      errorMessage: "child_timeout",
      memoryAfterBytes: 0,
      memoryBeforeBytes: 0,
      mode,
      scenarioId: scenario.id,
      trace: null,
    };
  }
  if (child.status !== 0) {
    throw new Error(`Routing validation child failed (${scenario.id}/${mode}):\n${child.stderr}`);
  }
  const line = child.stdout.split(/\r?\n/u).find((entry) => entry.startsWith(CHILD_MARKER));
  if (!line) throw new Error(`Routing validation child returned no record:\n${child.stdout}`);
  return JSON.parse(line.slice(CHILD_MARKER.length)) as ValidationRecord;
}

async function runChildProcess(
  mode: ValidationMode,
  scenario: (typeof SOLVER_PORTFOLIO_ROUTING_VALIDATION_SCENARIOS)[number],
) {
  const productBytes = await readFile(resolve(REPO_ROOT, PRODUCT_WASM_PATH));
  const rescueBytes =
    mode === "branch-bound-b2-on-capacity"
      ? await readFile(resolve(REPO_ROOT, BRANCH_BOUND_WASM_PATH))
      : productBytes;
  const instances = {
    minEfTier21: await instantiate(productBytes),
    phase2: await instantiate(productBytes),
    ...(mode === "baseline" ? {} : { rescue: await instantiate(rescueBytes) }),
  };
  const memories = Object.values(instances).map((instance) => requireMemory(instance.exports));
  const memoryBeforeBytes = memories.reduce((sum, memory) => sum + memory.buffer.byteLength, 0);
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "error",
    optimizeDeps: { noDiscovery: true },
    server: { hmr: false, middlewareMode: true },
  });
  const startedAt = performance.now();
  let record: ValidationRecord;
  try {
    const routing = (await server.ssrLoadModule(
      "/benchmarks/solver-portfolio-routing.ts",
    )) as typeof import("./solver-portfolio-routing");
    const session = routing.createSolverPortfolioLadderSession(mode, instances);
    try {
      const result = session.solve({
        start: scenario.start,
        stock: scenario.stock,
        strategy: "supply",
      });
      record = {
        decision: result.decision,
        elapsedMs: performance.now() - startedAt,
        errorMessage: null,
        memoryAfterBytes: memories.reduce((sum, memory) => sum + memory.buffer.byteLength, 0),
        memoryBeforeBytes,
        mode,
        scenarioId: scenario.id,
        trace: result.trace,
      };
    } finally {
      session.release();
    }
  } catch (error) {
    record = {
      decision: null,
      elapsedMs: performance.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      memoryAfterBytes: memories.reduce((sum, memory) => sum + memory.buffer.byteLength, 0),
      memoryBeforeBytes,
      mode,
      scenarioId: scenario.id,
      trace: null,
    };
  } finally {
    await server.close();
  }
  console.log(`${CHILD_MARKER}${JSON.stringify(record)}`);
}

function createReport(provenance: ResearchProvenance): Report {
  return {
    kind: "solver-portfolio-routing-validation",
    version: 1,
    generatedAt: new Date().toISOString(),
    provenance,
    artifacts: {
      product: fingerprintResearchArtifact(REPO_ROOT, PRODUCT_WASM_PATH),
      branchBound: fingerprintResearchArtifact(REPO_ROOT, BRANCH_BOUND_WASM_PATH),
    },
    contract: SOLVER_PORTFOLIO_ROUTING_CONTRACT,
    validationRule: CONDITIONAL_EXACT_RESCUE_RULE,
    options: {
      scenarioIds: SOLVER_PORTFOLIO_ROUTING_VALIDATION_SCENARIOS.map((scenario) => scenario.id),
      childTimeoutMs: CHILD_TIMEOUT_MS,
    },
    records: [],
    summary: summarize([]),
    decisionScope: { productAdoptionAuthorized: false, researchOnly: true },
  };
}

function summarize(records: ValidationRecord[]) {
  const comparisons = SOLVER_PORTFOLIO_ROUTING_VALIDATION_SCENARIOS.flatMap((scenario) => {
    const baseline = records.find(
      (record) => record.scenarioId === scenario.id && record.mode === "baseline",
    );
    const candidate = records.find(
      (record) => record.scenarioId === scenario.id && record.mode === "conditional-min-ef-tier22",
    );
    return baseline && candidate ? [{ baseline, candidate, scenario }] : [];
  });
  const capacityFailures = comparisons.filter(({ baseline }) =>
    baseline.trace ? baseline.trace.minEfTier21.outcome !== "completed" : false,
  );
  const eligibleFailures = capacityFailures.filter(({ scenario }) =>
    conditionalExactRescueEligible({ start: scenario.start, stock: scenario.stock }),
  );
  const rescueAttempts = eligibleFailures.filter(
    ({ candidate }) => candidate.trace?.rescue.arm === "min-ef-tier22",
  );
  const rescueCompletions = rescueAttempts.filter(
    ({ candidate }) => candidate.trace?.rescue.outcome === "completed",
  );
  const latencyPasses = rescueCompletions.filter(({ baseline, candidate }) =>
    portfolioRouteLatencyPassed(
      baseline.trace?.totalElapsedMs ?? Number.POSITIVE_INFINITY,
      candidate.trace?.totalElapsedMs ?? Number.POSITIVE_INFINITY,
    ),
  );
  const branchBoundComparisons = capacityFailures.flatMap(({ baseline, scenario }) => {
    const candidate = records.find(
      (record) =>
        record.scenarioId === scenario.id && record.mode === "branch-bound-b2-on-capacity",
    );
    return candidate ? [{ baseline, candidate }] : [];
  });
  const branchBoundCompletions = branchBoundComparisons.filter(
    ({ candidate }) => candidate.trace?.rescue.outcome === "completed",
  );
  const branchBoundLatencyPasses = branchBoundCompletions.filter(({ baseline, candidate }) =>
    portfolioRouteLatencyPassed(
      baseline.trace?.totalElapsedMs ?? Number.POSITIVE_INFINITY,
      candidate.trace?.totalElapsedMs ?? Number.POSITIVE_INFINITY,
    ),
  );
  const directComparisons = comparisons.flatMap(({ baseline, scenario }) => {
    if (!conditionalExactRescueEligible({ start: scenario.start, stock: scenario.stock }))
      return [];
    const candidate = records.find(
      (record) =>
        record.scenarioId === scenario.id && record.mode === "direct-conditional-min-ef-tier22",
    );
    return candidate ? [{ baseline, candidate }] : [];
  });
  const directCompletions = directComparisons.filter(
    ({ candidate }) => candidate.trace?.rescue.outcome === "completed",
  );
  const directLatencyPasses = directCompletions.filter(({ baseline, candidate }) =>
    portfolioRouteLatencyPassed(
      baseline.trace?.totalElapsedMs ?? Number.POSITIVE_INFINITY,
      candidate.trace?.totalElapsedMs ?? Number.POSITIVE_INFINITY,
    ),
  );
  return {
    expectedRecords: SOLVER_PORTFOLIO_ROUTING_VALIDATION_SCENARIOS.length * MODES.length,
    completedRecords: records.length,
    comparedScenarios: comparisons.length,
    capacityFailures: capacityFailures.length,
    eligibleCapacityFailures: eligibleFailures.length,
    rescueAttempts: rescueAttempts.length,
    rescueCompletions: rescueCompletions.length,
    rescueLatencyPasses: latencyPasses.length,
    allEligibleRescued:
      rescueAttempts.length > 0 && rescueAttempts.length === rescueCompletions.length,
    allRescuesPassLatency:
      rescueCompletions.length > 0 && rescueCompletions.length === latencyPasses.length,
    branchBoundAttempts: branchBoundComparisons.length,
    branchBoundCompletions: branchBoundCompletions.length,
    branchBoundLatencyPasses: branchBoundLatencyPasses.length,
    allBranchBoundRescuesPassLatency:
      branchBoundCompletions.length > 0 &&
      branchBoundCompletions.length === branchBoundLatencyPasses.length,
    directRuleMatches: directComparisons.length,
    directCompletions: directCompletions.length,
    directLatencyPasses: directLatencyPasses.length,
    allDirectRoutesPass:
      directComparisons.length > 0 &&
      directComparisons.length === directCompletions.length &&
      directCompletions.length === directLatencyPasses.length,
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

async function instantiate(bytes: Uint8Array) {
  const result = (await WebAssembly.instantiate(bytes)) as
    | WebAssembly.Instance
    | WebAssembly.WebAssemblyInstantiatedSource;
  return result instanceof WebAssembly.Instance ? result : result.instance;
}

function requireMemory(exports: WebAssembly.Exports) {
  const memory = (exports as WebAssembly.Exports & { memory?: WebAssembly.Memory }).memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("WASM memory export is missing.");
  return memory;
}

if (process.argv[2] === "--child") {
  const mode = process.argv[3] as SolverPortfolioRouteMode;
  if (!MODES.includes(mode as ValidationMode))
    throw new Error(`Unsupported validation mode: ${mode}`);
  const scenario = JSON.parse(
    Buffer.from(process.argv[4] ?? "", "base64url").toString("utf8"),
  ) as (typeof SOLVER_PORTFOLIO_ROUTING_VALIDATION_SCENARIOS)[number];
  await runChildProcess(mode as ValidationMode, scenario);
} else {
  await runParent();
}
