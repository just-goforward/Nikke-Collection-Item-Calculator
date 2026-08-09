import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

import type { CollectionState, KitVector } from "../src/solver/domain";
import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  type ResearchProvenance,
} from "./research-provenance.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUTPUT_URL = new URL("./results/min-ef-branch-bound-study.json", import.meta.url);
const STUDY_ID = "min-ef-branch-bound-b0";
const PROTOCOL_VERSION = 1;

type Scenario = {
  id: string;
  start: CollectionState;
  stock: KitVector;
};

type BranchBoundReport = {
  kind: "min-ef-branch-bound-study";
  version: 1;
  generatedAt: string;
  provenance: ResearchProvenance;
  contract: typeof CONTRACT;
  records: Array<{
    scenarioId: string;
    rootAction: string | null;
    rootSuccess: number;
    rootExpectedCost: number;
    memoStates: number;
    eligibleActions: number;
    canonicalPrunableActions: number;
    bestFirstPrunableActions: number;
    canonicalPruneRate: number;
    bestFirstPruneRate: number;
    boundViolations: number;
  }>;
  summary: {
    memoStates: number;
    eligibleActions: number;
    canonicalPrunableActions: number;
    bestFirstPrunableActions: number;
    canonicalPruneRate: number;
    bestFirstPruneRate: number;
    boundViolations: number;
    evidenceScope: "tiny-direct-enumeration";
  };
};

const SCENARIOS: Scenario[] = [
  scenario("R0-balanced3", "R", 0, 0, 31, 31, 31),
  scenario("R10-balanced4", "R", 10, 0, 41, 41, 41),
  scenario("R14e900-balanced3", "R", 14, 900, 31, 31, 31),
  scenario("SR5-blue-scarce", "SR", 5, 0, 11, 41, 41),
  scenario("SR10-purple-scarce", "SR", 10, 0, 41, 11, 41),
  scenario("SR10-yellow-scarce", "SR", 10, 0, 41, 41, 11),
  scenario("SR14e2900-balanced2", "SR", 14, 2_900, 21, 21, 21),
];

const CONTRACT = {
  candidate: "B0-immediate-consumption-monotone-lower-bound",
  horizonFactor: 0.75,
  normPower: 3,
  tolerance: 0,
  actionOrder: ["blue", "purple", "yellow"],
  scenarios: SCENARIOS,
  interpretation: {
    exactness: "direct enumeration compared with product min-E[f] in benchmark specs",
    canonicalPruning:
      "eligible actions are considered in product action order after an exact success prepass",
    bestFirstPruning: "oracle upper estimate after the exact best action is evaluated first",
    hardFixtureGateDeferred: true,
  },
} as const;

async function main() {
  const provenance = collectResearchProvenance({
    repoRoot: REPO_ROOT,
    studyId: STUDY_ID,
    protocolVersion: PROTOCOL_VERSION,
    contract: CONTRACT,
    sourceFiles: [
      "benchmarks/min-ef-branch-bound.ts",
      "benchmarks/min-ef-branch-bound.spec.ts",
      "benchmarks/run-min-ef-branch-bound-study.ts",
      "benchmarks/research-provenance.ts",
      "src/solver/cost.ts",
      "src/solver/domain.ts",
      "rust/solver-rs/src/cost.rs",
      "rust/solver-rs/src/lib.rs",
      "rust/solver-rs/src/minef.rs",
    ],
    wasmPath: "public/solver_rs.wasm",
  });
  const existing = await readExistingReport();
  assertResearchReportCanBeWritten(existing, provenance);

  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "error",
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  let records: BranchBoundReport["records"];
  try {
    const branchBound = (await server.ssrLoadModule(
      "/benchmarks/min-ef-branch-bound.ts",
    )) as typeof import("./min-ef-branch-bound");
    records = SCENARIOS.map(({ id, start, stock }) => {
      const result = branchBound.enumerateTinyMinEf(start, stock, CONTRACT);
      const eligible = result.stats.eligibleActions;
      return {
        scenarioId: id,
        rootAction: result.root.action,
        rootSuccess: result.root.success,
        rootExpectedCost: result.root.expectedCost,
        memoStates: result.stats.memoStates,
        eligibleActions: eligible,
        canonicalPrunableActions: result.stats.canonicalPrunableActions,
        bestFirstPrunableActions: result.stats.bestFirstPrunableActions,
        canonicalPruneRate: ratio(result.stats.canonicalPrunableActions, eligible),
        bestFirstPruneRate: ratio(result.stats.bestFirstPrunableActions, eligible),
        boundViolations: result.stats.boundViolations,
      };
    });
  } finally {
    await server.close();
  }
  const eligibleActions = sum(records, (record) => record.eligibleActions);
  const canonicalPrunableActions = sum(records, (record) => record.canonicalPrunableActions);
  const bestFirstPrunableActions = sum(records, (record) => record.bestFirstPrunableActions);
  const report: BranchBoundReport = {
    kind: "min-ef-branch-bound-study",
    version: 1,
    generatedAt: new Date().toISOString(),
    provenance,
    contract: CONTRACT,
    records,
    summary: {
      memoStates: sum(records, (record) => record.memoStates),
      eligibleActions,
      canonicalPrunableActions,
      bestFirstPrunableActions,
      canonicalPruneRate: ratio(canonicalPrunableActions, eligibleActions),
      bestFirstPruneRate: ratio(bestFirstPrunableActions, eligibleActions),
      boundViolations: sum(records, (record) => record.boundViolations),
      evidenceScope: "tiny-direct-enumeration",
    },
  };

  await writeFile(OUTPUT_URL, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        output: relative(REPO_ROOT, fileURLToPath(OUTPUT_URL)),
        sourceFingerprint: provenance.sourceFingerprint,
        summary: report.summary,
      },
      null,
      2,
    ),
  );
}

function scenario(
  id: string,
  grade: CollectionState["grade"],
  level: number,
  exp: number,
  blue: number,
  purple: number,
  yellow: number,
): Scenario {
  return { id, start: { grade, level, exp }, stock: { blue, purple, yellow } };
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function sum<T>(rows: T[], select: (row: T) => number): number {
  return rows.reduce((total, row) => total + select(row), 0);
}

async function readExistingReport(): Promise<BranchBoundReport | null> {
  try {
    return JSON.parse(await readFile(OUTPUT_URL, "utf8")) as BranchBoundReport;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

void main();
