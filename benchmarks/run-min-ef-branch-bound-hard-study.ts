import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  fingerprintResearchArtifact,
  type ResearchProvenance,
} from "./research-provenance.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CANDIDATE_PATH = "output/solver_rs-branch-bound-audit.wasm";
const PRODUCT_PATH = "public/solver_rs.wasm";
const OUTPUT_URL = new URL("./results/min-ef-branch-bound-hard-study.json", import.meta.url);

type Scenario = {
  id: string;
  memoTier: number;
  start: { grade: "R" | "SR"; level: number; exp: number };
  stock: { blue: number; purple: number; yellow: number };
};

type AuditExports = WebAssembly.Exports & {
  configureMinEfMemo: (tier: number) => void;
  configureNodeBudget?: (budget: number) => void;
  getSolveStatus: () => number;
  minEfAction: () => number;
  minEfBranchBoundActuallyEligibleActions: () => number;
  minEfBranchBoundAuditedStates: () => number;
  minEfBranchBoundBestFirstPrunableActions: () => number;
  minEfBranchBoundCanonicalPrunableActions: () => number;
  minEfBranchBoundEligibilityMismatches: () => number;
  minEfBranchBoundMaxPolicySuccessGap: () => number;
  minEfBranchBoundPotentiallyEligibleActions: () => number;
  minEfBranchBoundViolations: () => number;
  minEfExpectedCost: () => number;
  minEfNodeCount: () => number;
  minEfSuccessProb: () => number;
  solveMinEf: (
    stateId: number,
    blue: number,
    purple: number,
    yellow: number,
    horizonFactor: number,
    normPower: number,
    tolerance: number,
  ) => void;
};

type BaselineExports = WebAssembly.Exports &
  Pick<
    AuditExports,
    | "configureMinEfMemo"
    | "configureNodeBudget"
    | "getSolveStatus"
    | "minEfAction"
    | "minEfExpectedCost"
    | "minEfNodeCount"
    | "minEfSuccessProb"
    | "solveMinEf"
  >;

const SCENARIOS: Scenario[] = [
  {
    id: "semantic-dominance-cap-tier21",
    memoTier: 21,
    start: { grade: "R", level: 0, exp: 0 },
    stock: { blue: 60, purple: 120, yellow: 900 },
  },
  {
    id: "R0-balanced250-tier22",
    memoTier: 22,
    start: { grade: "R", level: 0, exp: 0 },
    stock: { blue: 250, purple: 250, yellow: 250 },
  },
  {
    id: "R0-balanced300-tier22",
    memoTier: 22,
    start: { grade: "R", level: 0, exp: 0 },
    stock: { blue: 300, purple: 300, yellow: 300 },
  },
  {
    id: "SR0-observedPurpleHigh-tier22",
    memoTier: 22,
    start: { grade: "SR", level: 0, exp: 0 },
    stock: { blue: 350, purple: 300, yellow: 150 },
  },
] as const;

const CONTRACT = {
  candidate: "B0-counterfactual-pruning-audit",
  candidateFeature: "research-branch-bound",
  horizonFactor: 0.75,
  normPower: 3,
  tolerance: 0,
  nodeBudget: 20_000_000,
  scenarios: SCENARIOS,
  rootCandidatePruning: false,
  counters: {
    canonical:
      "potentially eligible actions skipped by LB0 after an actually eligible canonical incumbent",
    bestFirst: "oracle upper estimate after the exact chosen action is evaluated first",
  },
} as const;

type SolveRecord = ReturnType<typeof solveBaseline>;

type HardStudyReport = {
  kind: "min-ef-branch-bound-hard-study";
  version: 1;
  generatedAt: string;
  provenance: ResearchProvenance;
  baselineWasm: ReturnType<typeof fingerprintResearchArtifact>;
  contract: typeof CONTRACT;
  records: Array<{
    scenarioId: string;
    baseline: SolveRecord;
    candidate: SolveRecord;
    parity: boolean;
    audit: {
      auditedStates: number;
      potentiallyEligibleActions: number;
      actuallyEligibleActions: number;
      eligibilityMismatches: number;
      canonicalPrunableActions: number;
      bestFirstPrunableActions: number;
      canonicalPruneRate: number;
      bestFirstPruneRate: number;
      boundViolations: number;
      maxPolicySuccessGap: number;
    };
  }>;
};

async function main() {
  const provenance = collectResearchProvenance({
    repoRoot: REPO_ROOT,
    studyId: "min-ef-branch-bound-b0-hard-audit",
    protocolVersion: 1,
    contract: CONTRACT,
    sourceFiles: [
      "benchmarks/run-min-ef-branch-bound-hard-study.ts",
      "benchmarks/research-provenance.ts",
      "scripts/build-solver-wasm-branch-bound.ts",
      "rust/solver-rs/Cargo.toml",
      "rust/solver-rs/src/constants.rs",
      "rust/solver-rs/src/cost.rs",
      "rust/solver-rs/src/lib.rs",
      "rust/solver-rs/src/minef.rs",
      "rust/solver-rs/src/state.rs",
      "rust/solver-rs/src/transition.rs",
    ],
    wasmPath: CANDIDATE_PATH,
  });
  const existing = await readExistingReport();
  assertResearchReportCanBeWritten(existing, provenance);

  const productModule = await WebAssembly.compile(
    await readFile(new URL(`../${PRODUCT_PATH}`, import.meta.url)),
  );
  const candidateModule = await WebAssembly.compile(
    await readFile(new URL(`../${CANDIDATE_PATH}`, import.meta.url)),
  );
  const records: HardStudyReport["records"] = [];
  for (const scenario of SCENARIOS) {
    const baseline = solveBaseline(
      requireBaselineExports((await WebAssembly.instantiate(productModule)).exports),
      scenario,
    );
    const candidateExports = requireAuditExports(
      (await WebAssembly.instantiate(candidateModule)).exports,
    );
    const candidate = solveBaseline(candidateExports, scenario);
    const denominator = candidateExports.minEfBranchBoundPotentiallyEligibleActions();
    const audit = {
      auditedStates: candidateExports.minEfBranchBoundAuditedStates(),
      potentiallyEligibleActions: denominator,
      actuallyEligibleActions: candidateExports.minEfBranchBoundActuallyEligibleActions(),
      eligibilityMismatches: candidateExports.minEfBranchBoundEligibilityMismatches(),
      canonicalPrunableActions: candidateExports.minEfBranchBoundCanonicalPrunableActions(),
      bestFirstPrunableActions: candidateExports.minEfBranchBoundBestFirstPrunableActions(),
      canonicalPruneRate: ratio(
        candidateExports.minEfBranchBoundCanonicalPrunableActions(),
        denominator,
      ),
      bestFirstPruneRate: ratio(
        candidateExports.minEfBranchBoundBestFirstPrunableActions(),
        denominator,
      ),
      boundViolations: candidateExports.minEfBranchBoundViolations(),
      maxPolicySuccessGap: candidateExports.minEfBranchBoundMaxPolicySuccessGap(),
    };
    records.push({
      scenarioId: scenario.id,
      baseline,
      candidate,
      parity: sameSolve(baseline, candidate),
      audit,
    });
    console.log(
      `${scenario.id}: ${candidate.outcome} nodes=${candidate.nodeCount} canonical=${formatPercent(audit.canonicalPruneRate)} best-first=${formatPercent(audit.bestFirstPruneRate)}`,
    );
  }

  const report: HardStudyReport = {
    kind: "min-ef-branch-bound-hard-study",
    version: 1,
    generatedAt: new Date().toISOString(),
    provenance,
    baselineWasm: fingerprintResearchArtifact(REPO_ROOT, PRODUCT_PATH),
    contract: CONTRACT,
    records,
  };
  await writeFile(OUTPUT_URL, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Wrote ${relative(REPO_ROOT, fileURLToPath(OUTPUT_URL))}`);
}

function isBaselineExports(exports: WebAssembly.Exports): exports is BaselineExports {
  return (
    typeof exports["configureMinEfMemo"] === "function" &&
    typeof exports["getSolveStatus"] === "function" &&
    typeof exports["minEfAction"] === "function" &&
    typeof exports["minEfExpectedCost"] === "function" &&
    typeof exports["minEfNodeCount"] === "function" &&
    typeof exports["minEfSuccessProb"] === "function" &&
    typeof exports["solveMinEf"] === "function"
  );
}

function requireBaselineExports(exports: WebAssembly.Exports): BaselineExports {
  if (!isBaselineExports(exports)) throw new Error("Required min-E[f] WASM exports are missing.");
  return exports;
}

function isAuditExports(exports: BaselineExports): exports is AuditExports {
  return (
    typeof exports["minEfBranchBoundActuallyEligibleActions"] === "function" &&
    typeof exports["minEfBranchBoundAuditedStates"] === "function" &&
    typeof exports["minEfBranchBoundBestFirstPrunableActions"] === "function" &&
    typeof exports["minEfBranchBoundCanonicalPrunableActions"] === "function" &&
    typeof exports["minEfBranchBoundEligibilityMismatches"] === "function" &&
    typeof exports["minEfBranchBoundMaxPolicySuccessGap"] === "function" &&
    typeof exports["minEfBranchBoundPotentiallyEligibleActions"] === "function" &&
    typeof exports["minEfBranchBoundViolations"] === "function"
  );
}

function requireAuditExports(exports: WebAssembly.Exports): AuditExports {
  const baseline = requireBaselineExports(exports);
  if (!isAuditExports(baseline)) {
    throw new Error("Required branch-bound audit exports are missing.");
  }
  return baseline;
}

function solveBaseline(exports: BaselineExports, scenario: Scenario) {
  exports.configureMinEfMemo(scenario.memoTier);
  exports.configureNodeBudget?.(CONTRACT.nodeBudget);
  const startedAt = performance.now();
  exports.solveMinEf(
    stateId(scenario.start),
    scenario.stock.blue,
    scenario.stock.purple,
    scenario.stock.yellow,
    CONTRACT.horizonFactor,
    CONTRACT.normPower,
    CONTRACT.tolerance,
  );
  const elapsedMs = performance.now() - startedAt;
  const status = exports.getSolveStatus();
  return {
    outcome: outcome(status),
    status,
    elapsedMs,
    nodeCount: exports.minEfNodeCount(),
    action: status === 0 ? exports.minEfAction() : null,
    successBits: status === 0 ? bits(exports.minEfSuccessProb()) : null,
    expectedCostBits: status === 0 ? bits(exports.minEfExpectedCost()) : null,
  };
}

function stateId(state: Scenario["start"]): number {
  return (((state.grade === "SR" ? 1 : 0) * 16 + state.level) * 30 + state.exp / 100) | 0;
}

function outcome(status: number): "completed" | "budget_exceeded" | "memo_full" | "failure" {
  if (status === 0) return "completed";
  if (status === 1) return "budget_exceeded";
  if (status === 2) return "memo_full";
  return "failure";
}

function sameSolve(left: SolveRecord, right: SolveRecord): boolean {
  return (
    left.outcome === right.outcome &&
    left.status === right.status &&
    left.nodeCount === right.nodeCount &&
    left.action === right.action &&
    left.successBits === right.successBits &&
    left.expectedCostBits === right.expectedCostBits
  );
}

function bits(value: number): string {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  return `0x${view.getBigUint64(0, false).toString(16).padStart(16, "0")}`;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

async function readExistingReport(): Promise<HardStudyReport | null> {
  try {
    return JSON.parse(await readFile(OUTPUT_URL, "utf8")) as HardStudyReport;
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
