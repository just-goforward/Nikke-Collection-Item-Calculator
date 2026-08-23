import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVE_SUPPLY_FORECAST_BASE_PROFILE } from "../shared/generated/supplyForecast.ts";

import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  fingerprintResearchArtifact,
  type ResearchProvenance,
} from "./research-provenance.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CANDIDATE_PATH = "output/solver_rs-branch-bound-audit.wasm";
const B1_PATH = "output/solver_rs-branch-bound-b1.wasm";
const PRODUCT_PATH = "public/solver_rs.wasm";
const OUTPUT_URL = new URL("./results/min-ef-branch-bound-compact-study-v2.json", import.meta.url);

type Scenario = {
  id: string;
  memoTier: number;
  start: { grade: "R" | "SR"; level: number; exp: number };
  stock: { blue: number; purple: number; yellow: number };
};

type SolverExports = WebAssembly.Exports & {
  configureMemo?: (tier: number) => void;
  configureMinEfMemo: (tier: number) => void;
  configureNodeBudget?: (budget: number) => void;
  getSolveStatus: () => number;
  memory: WebAssembly.Memory;
  minEfAction: () => number;
  minEfExpectedCost: () => number;
  minEfMaxSuccessProb: () => number;
  minEfNodeCount: () => number;
  minEfRootCandidateExpectedCost: (action: number) => number;
  minEfRootCandidateMaxSuccessProb: () => number;
  minEfRootCandidateSuccessProb: (action: number) => number;
  minEfRootCandidateValid: (action: number) => number;
  minEfRootCandidateVecB: (action: number) => number;
  minEfRootCandidateVecP: (action: number) => number;
  minEfRootCandidateVecY: (action: number) => number;
  minEfSuccessProb: () => number;
  minEfVecB: () => number;
  minEfVecP: () => number;
  minEfVecY: () => number;
  solveMinEf: (
    stateId: number,
    blue: number,
    purple: number,
    yellow: number,
    gainBlue: number,
    gainPurple: number,
    gainYellow: number,
    horizonFactor: number,
    normPower: number,
    tolerance: number,
  ) => void;
};

type CandidateExports = SolverExports & {
  configureMinEfBranchBoundPruning: (mode: number) => number;
  configureMinEfBranchBoundSuccessMemo: (tier: number) => void;
  minEfBranchBoundAppliedPrunes: () => number;
  minEfBranchBoundOracleStates: () => number;
  minEfBranchBoundPrepassMismatches: () => number;
  minEfBranchBoundPrepassRootActionMaxSuccess: (action: number) => number;
  minEfBranchBoundPrepassRootActionValid: (action: number) => number;
  minEfBranchBoundPrepassRootMaxSuccess: () => number;
  minEfBranchBoundPrepassStates: () => number;
};

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
  candidate: "B2-compact-maximum-success-oracle",
  candidateFeature: "research-branch-bound",
  horizonFactor: 0.75,
  normPower: 3,
  tolerance: 0,
  nodeBudget: 20_000_000,
  modes: { phase2: 1, compact: 2 },
  scenarios: SCENARIOS,
  rootCandidatePruning: false,
  screeningOnly: true,
} as const;

type RootCandidateSnapshot = {
  valid: boolean;
  successBits: string | null;
  vectorBits: [string, string, string] | null;
  expectedCostBits: string | null;
};

type SemanticSnapshot = {
  action: number;
  maxSuccessBits: string;
  successBits: string;
  vectorBits: [string, string, string];
  expectedCostBits: string;
  rootMaxSuccessBits: string;
  rootCandidates: RootCandidateSnapshot[];
};

type OracleSnapshot = {
  rootMaxSuccessBits: string;
  rootActions: Array<{ valid: boolean; maximumSuccessBits: string | null }>;
};

type SolveRecord = {
  outcome: ReturnType<typeof outcome>;
  status: number;
  elapsedMs: number;
  memoryBeforeBytes: number;
  memoryAfterBytes: number;
  memoryGrowthBytes: number;
  minEfNodeCount: number;
  semantic: SemanticSnapshot | null;
};

type CandidateRecord = SolveRecord & {
  appliedPrunes: number;
  prepassStates: number;
  oracleStates: number;
  prepassMismatches: number;
  combinedNodeCount: number;
  oracle: OracleSnapshot;
};

type StudyReport = {
  kind: "min-ef-branch-bound-compact-study";
  version: 1;
  generatedAt: string;
  provenance: ResearchProvenance;
  productWasm: ReturnType<typeof fingerprintResearchArtifact>;
  b1Wasm: ReturnType<typeof fingerprintResearchArtifact>;
  contract: typeof CONTRACT;
  records: Array<{
    scenarioId: string;
    product: SolveRecord;
    phase2Oracle: CandidateRecord;
    compactOracle: CandidateRecord;
    productVsCompact: ReturnType<typeof compareRecords>;
    phase2VsCompact: ReturnType<typeof compareRecords>;
    oracleParity: boolean;
    minEfNodeRatioVsProduct: number | null;
    combinedNodeRatioVsProduct: number | null;
    memoryDeltaVsProductBytes: number;
  }>;
};

async function main() {
  const provenance = collectResearchProvenance({
    repoRoot: REPO_ROOT,
    studyId: "min-ef-branch-bound-b2-compact-screen",
    protocolVersion: 2,
    contract: CONTRACT,
    sourceFiles: [
      "benchmarks/run-min-ef-branch-bound-compact-study.ts",
      "benchmarks/research-provenance.ts",
      "scripts/build-solver-wasm-branch-bound.ts",
      "rust/solver-rs/Cargo.toml",
      "rust/solver-rs/src/constants.rs",
      "rust/solver-rs/src/cost.rs",
      "rust/solver-rs/src/lib.rs",
      "rust/solver-rs/src/minef.rs",
      "rust/solver-rs/src/state.rs",
      "rust/solver-rs/src/status.rs",
      "rust/solver-rs/src/transition.rs",
    ],
    wasmPath: CANDIDATE_PATH,
  });
  assertResearchReportCanBeWritten(await readExistingReport(), provenance);

  const productModule = await compile(PRODUCT_PATH);
  const candidateModule = await compile(CANDIDATE_PATH);
  const records: StudyReport["records"] = [];
  for (const scenario of SCENARIOS) {
    const product = await solveProduct(productModule, scenario);
    const phase2Oracle = await solveCandidate(candidateModule, scenario, CONTRACT.modes.phase2);
    const compactOracle = await solveCandidate(candidateModule, scenario, CONTRACT.modes.compact);
    records.push({
      scenarioId: scenario.id,
      product,
      phase2Oracle,
      compactOracle,
      productVsCompact: compareRecords(product, compactOracle),
      phase2VsCompact: compareRecords(phase2Oracle, compactOracle),
      oracleParity: JSON.stringify(phase2Oracle.oracle) === JSON.stringify(compactOracle.oracle),
      minEfNodeRatioVsProduct: ratio(compactOracle.minEfNodeCount, product.minEfNodeCount),
      combinedNodeRatioVsProduct: ratio(compactOracle.combinedNodeCount, product.minEfNodeCount),
      memoryDeltaVsProductBytes: compactOracle.memoryGrowthBytes - product.memoryGrowthBytes,
    });
    console.log(
      [
        scenario.id,
        `product=${product.outcome}/${product.minEfNodeCount}`,
        `phase2=${phase2Oracle.outcome}/${phase2Oracle.combinedNodeCount}`,
        `compact=${compactOracle.outcome}/${compactOracle.combinedNodeCount}`,
        `oracle=${JSON.stringify(phase2Oracle.oracle) === JSON.stringify(compactOracle.oracle)}`,
        `semantic=${compareRecords(phase2Oracle, compactOracle)}`,
      ].join(" "),
    );
  }

  const report: StudyReport = {
    kind: "min-ef-branch-bound-compact-study",
    version: 1,
    generatedAt: new Date().toISOString(),
    provenance,
    productWasm: fingerprintResearchArtifact(REPO_ROOT, PRODUCT_PATH),
    b1Wasm: fingerprintResearchArtifact(REPO_ROOT, B1_PATH),
    contract: CONTRACT,
    records,
  };
  await writeFile(OUTPUT_URL, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Wrote ${relative(REPO_ROOT, fileURLToPath(OUTPUT_URL))}`);
}

async function compile(path: string): Promise<WebAssembly.Module> {
  return WebAssembly.compile(await readFile(new URL(`../${path}`, import.meta.url)));
}

async function solveProduct(module: WebAssembly.Module, scenario: Scenario): Promise<SolveRecord> {
  const exports = requireSolverExports((await WebAssembly.instantiate(module)).exports);
  return solve(exports, scenario);
}

async function solveCandidate(
  module: WebAssembly.Module,
  scenario: Scenario,
  mode: number,
): Promise<CandidateRecord> {
  const exports = requireCandidateExports((await WebAssembly.instantiate(module)).exports);
  if (exports.configureMinEfBranchBoundPruning(mode) !== 1) {
    throw new Error(`Candidate rejected branch-bound mode ${mode}.`);
  }
  exports.configureMinEfBranchBoundSuccessMemo(scenario.memoTier);
  const base = solve(exports, scenario);
  const oracleStates = exports.minEfBranchBoundOracleStates();
  return {
    ...base,
    appliedPrunes: exports.minEfBranchBoundAppliedPrunes(),
    prepassStates: exports.minEfBranchBoundPrepassStates(),
    oracleStates,
    prepassMismatches: exports.minEfBranchBoundPrepassMismatches(),
    combinedNodeCount: base.minEfNodeCount + oracleStates,
    oracle: {
      rootMaxSuccessBits: bits(exports.minEfBranchBoundPrepassRootMaxSuccess()),
      rootActions: [0, 1, 2].map((action) => {
        const valid = exports.minEfBranchBoundPrepassRootActionValid(action) === 1;
        return {
          valid,
          maximumSuccessBits: valid
            ? bits(exports.minEfBranchBoundPrepassRootActionMaxSuccess(action))
            : null,
        };
      }),
    },
  };
}

function solve(exports: SolverExports, scenario: Scenario): SolveRecord {
  exports.configureMemo?.(scenario.memoTier);
  exports.configureMinEfMemo(scenario.memoTier);
  exports.configureNodeBudget?.(CONTRACT.nodeBudget);
  const memoryBeforeBytes = exports.memory.buffer.byteLength;
  const startedAt = performance.now();
  exports.solveMinEf(
    stateId(scenario.start),
    scenario.stock.blue,
    scenario.stock.purple,
    scenario.stock.yellow,
    ACTIVE_SUPPLY_FORECAST_BASE_PROFILE.expectedGain.blue,
    ACTIVE_SUPPLY_FORECAST_BASE_PROFILE.expectedGain.purple,
    ACTIVE_SUPPLY_FORECAST_BASE_PROFILE.expectedGain.yellow,
    CONTRACT.horizonFactor,
    CONTRACT.normPower,
    CONTRACT.tolerance,
  );
  const elapsedMs = performance.now() - startedAt;
  const memoryAfterBytes = exports.memory.buffer.byteLength;
  const status = exports.getSolveStatus();
  return {
    outcome: outcome(status),
    status,
    elapsedMs,
    memoryBeforeBytes,
    memoryAfterBytes,
    memoryGrowthBytes: memoryAfterBytes - memoryBeforeBytes,
    minEfNodeCount: exports.minEfNodeCount(),
    semantic: status === 0 ? semanticSnapshot(exports) : null,
  };
}

function semanticSnapshot(exports: SolverExports): SemanticSnapshot {
  return {
    action: exports.minEfAction(),
    maxSuccessBits: bits(exports.minEfMaxSuccessProb()),
    successBits: bits(exports.minEfSuccessProb()),
    vectorBits: [bits(exports.minEfVecB()), bits(exports.minEfVecP()), bits(exports.minEfVecY())],
    expectedCostBits: bits(exports.minEfExpectedCost()),
    rootMaxSuccessBits: bits(exports.minEfRootCandidateMaxSuccessProb()),
    rootCandidates: [0, 1, 2].map((action) => {
      const valid = exports.minEfRootCandidateValid(action) === 1;
      return {
        valid,
        successBits: valid ? bits(exports.minEfRootCandidateSuccessProb(action)) : null,
        vectorBits: valid
          ? [
              bits(exports.minEfRootCandidateVecB(action)),
              bits(exports.minEfRootCandidateVecP(action)),
              bits(exports.minEfRootCandidateVecY(action)),
            ]
          : null,
        expectedCostBits: valid ? bits(exports.minEfRootCandidateExpectedCost(action)) : null,
      };
    }),
  };
}

function isSolverExports(exports: WebAssembly.Exports): exports is SolverExports {
  return (
    exports["memory"] instanceof WebAssembly.Memory &&
    typeof exports["configureMinEfMemo"] === "function" &&
    typeof exports["getSolveStatus"] === "function" &&
    typeof exports["minEfAction"] === "function" &&
    typeof exports["minEfExpectedCost"] === "function" &&
    typeof exports["minEfMaxSuccessProb"] === "function" &&
    typeof exports["minEfNodeCount"] === "function" &&
    typeof exports["minEfRootCandidateExpectedCost"] === "function" &&
    typeof exports["minEfRootCandidateMaxSuccessProb"] === "function" &&
    typeof exports["minEfRootCandidateSuccessProb"] === "function" &&
    typeof exports["minEfRootCandidateValid"] === "function" &&
    typeof exports["minEfRootCandidateVecB"] === "function" &&
    typeof exports["minEfRootCandidateVecP"] === "function" &&
    typeof exports["minEfRootCandidateVecY"] === "function" &&
    typeof exports["minEfSuccessProb"] === "function" &&
    typeof exports["minEfVecB"] === "function" &&
    typeof exports["minEfVecP"] === "function" &&
    typeof exports["minEfVecY"] === "function" &&
    typeof exports["solveMinEf"] === "function"
  );
}

function requireSolverExports(exports: WebAssembly.Exports): SolverExports {
  if (!isSolverExports(exports)) throw new Error("Required min-E[f] WASM exports are missing.");
  return exports;
}

function isCandidateExports(exports: SolverExports): exports is CandidateExports {
  return (
    typeof exports["configureMinEfBranchBoundPruning"] === "function" &&
    typeof exports["configureMinEfBranchBoundSuccessMemo"] === "function" &&
    typeof exports["minEfBranchBoundAppliedPrunes"] === "function" &&
    typeof exports["minEfBranchBoundOracleStates"] === "function" &&
    typeof exports["minEfBranchBoundPrepassMismatches"] === "function" &&
    typeof exports["minEfBranchBoundPrepassRootActionMaxSuccess"] === "function" &&
    typeof exports["minEfBranchBoundPrepassRootActionValid"] === "function" &&
    typeof exports["minEfBranchBoundPrepassRootMaxSuccess"] === "function" &&
    typeof exports["minEfBranchBoundPrepassStates"] === "function"
  );
}

function requireCandidateExports(exports: WebAssembly.Exports): CandidateExports {
  const solver = requireSolverExports(exports);
  if (!isCandidateExports(solver)) {
    throw new Error("Required branch-bound candidate exports are missing.");
  }
  return solver;
}

function compareRecords(
  baseline: Pick<SolveRecord, "outcome" | "status" | "semantic">,
  candidate: Pick<SolveRecord, "outcome" | "status" | "semantic">,
): "equal" | "completion_gain" | "status_mismatch" | "semantic_mismatch" {
  if (baseline.status !== 0 && candidate.status === 0) return "completion_gain";
  if (baseline.status !== candidate.status || baseline.outcome !== candidate.outcome) {
    return "status_mismatch";
  }
  if (baseline.status !== 0) return "equal";
  return JSON.stringify(baseline.semantic) === JSON.stringify(candidate.semantic)
    ? "equal"
    : "semantic_mismatch";
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

function bits(value: number): string {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  return `0x${view.getBigUint64(0, false).toString(16).padStart(16, "0")}`;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

async function readExistingReport(): Promise<StudyReport | null> {
  try {
    return JSON.parse(await readFile(OUTPUT_URL, "utf8")) as StudyReport;
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
