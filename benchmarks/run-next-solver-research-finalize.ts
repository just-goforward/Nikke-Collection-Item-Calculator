import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

import type { ResearchCandidateId, ResearchGrade } from "./next-solver-research-contract.ts";
import {
  buildResearchDecisionLedger,
  type DirectCandidateEvidence,
} from "./next-solver-research-ledger.ts";
import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  fingerprintResearchArtifact,
  readOptionalResearchReport,
} from "./research-provenance.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = resolve(REPO_ROOT, "benchmarks/results");
const OUTPUT = resolve(RESULTS, "next-solver-research-v1.json");
const CONTRACT = {
  kind: "next-solver-research",
  version: 1,
  primaryFixture: "R10-balanced300",
  exactStateBudget: 1_200_000,
  productRuntimeRewired: false,
} as const;

type Adoption = { grade: ResearchGrade; reason: string };

function readResult<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(RESULTS, name), "utf8")) as T;
}

const webgpu = readResult<{
  measurement: {
    exactSetMatch: boolean;
    capacityCensus: { outcome: string; states: number; layers: number };
  };
}>("webgpu-compact-frontier-v1.json");
const android = readResult<{ result: { outcome: string } }>("webgpu-frontier-android-v1.json");
const limitedDepth = readResult<{ adoption: Adoption }>("certified-limited-depth-v1.json");
const lp = readResult<{ solver: { outcome: string } }>("compact-lp-oracle-v1.json");
const structure = readResult<{
  pareto: { adoption: Adoption };
  monotonicity: { adoption: Adoption };
  symbolic: { adoption: Adoption };
}>("structure-candidate-screen-v1.json");

type CompleteOracleEvidence = {
  graphStates: number;
  policiesEvaluated: number;
  actionMatch: boolean;
  successProbabilityMatch: boolean;
  expectedCostMatch: boolean;
};

const vite = await createServer({
  root: REPO_ROOT,
  logLevel: "error",
  server: { hmr: false, middlewareMode: true },
});
let completeOracle: CompleteOracleEvidence;
try {
  const compact = (await vite.ssrLoadModule(
    "/benchmarks/compact-exact-graph.ts",
  )) as typeof import("./compact-exact-graph");
  const oracle = (await vite.ssrLoadModule(
    "/benchmarks/complete-policy-oracle.ts",
  )) as typeof import("./complete-policy-oracle");
  const built = compact.buildCompactStateGraph(
    { grade: "SR", level: 14, exp: 2900 },
    { blue: 10, purple: 10, yellow: 10 },
    { stateBudget: 100 },
  );
  if (built.outcome !== "completed") throw new Error("Complete-policy oracle fixture failed.");
  const compactSolution = compact.solveCompactMinEf(built.graph);
  const enumerated = oracle.enumerateCompletePolicies(
    built.graph,
    (key) => {
      const value = compactSolution.values.get(key);
      if (!value) throw new Error(`Complete-policy oracle is missing leaf ${key}.`);
      return value.expectedCost;
    },
    1_000,
  );
  completeOracle = {
    graphStates: built.graph.nodes.length,
    policiesEvaluated: enumerated.policiesEvaluated,
    actionMatch: enumerated.root.action === compactSolution.root.action,
    successProbabilityMatch:
      enumerated.root.successProbability === compactSolution.root.successProbability,
    expectedCostMatch: enumerated.root.expectedCost === compactSolution.root.expectedCost,
  };
} finally {
  await vite.close();
}
if (
  !completeOracle.actionMatch ||
  !completeOracle.successProbabilityMatch ||
  !completeOracle.expectedCostMatch
) {
  throw new Error("Complete-policy oracle did not match compact exact DP.");
}

const evidence = new Map<ResearchCandidateId, DirectCandidateEvidence>([
  [
    "complete_policy_enumeration",
    {
      execution: "completed",
      grade: "verification_incomplete",
      prerequisitePassed: true,
      reason: "Tiny complete-policy enumeration matched the compact exact DP root bit-for-bit.",
      evidence: ["completePolicyOracle"],
    },
  ],
  [
    "lp_column_generation_oracle",
    {
      execution: lp.solver.outcome === "completed" ? "completed" : "failed",
      grade: "verification_incomplete",
      prerequisitePassed: lp.solver.outcome === "completed",
      reason:
        lp.solver.outcome === "completed"
          ? "The independent LP solver completed."
          : "The deterministic MPS model was emitted, but no HiGHS executable was configured.",
      evidence: ["compact-lp-oracle-v1.json"],
    },
  ],
  [
    "webgpu_compact_exact_hybrid",
    {
      execution: "completed",
      grade: "rejected",
      prerequisitePassed: false,
      reason: `Desktop integer-frontier parity=${webgpu.measurement.exactSetMatch}; R10 capacity=${webgpu.measurement.capacityCensus.outcome} after ${webgpu.measurement.capacityCensus.states} states and ${webgpu.measurement.capacityCensus.layers} layers; Android=${android.result.outcome}. The CPU f64 Bellman stage was not reached within the registered ceiling.`,
      evidence: ["webgpu-compact-frontier-v1.json", "webgpu-frontier-android-v1.json"],
    },
  ],
  [
    "certified_limited_depth",
    {
      execution: "completed",
      grade: limitedDepth.adoption.grade,
      prerequisitePassed: limitedDepth.adoption.grade === "product_candidate",
      reason: limitedDepth.adoption.reason,
      evidence: ["certified-limited-depth-v1.json"],
    },
  ],
  [
    "pareto_frontier_dp",
    {
      execution: "completed",
      grade: structure.pareto.adoption.grade,
      prerequisitePassed: structure.pareto.adoption.grade === "product_candidate",
      reason: structure.pareto.adoption.reason,
      evidence: ["structure-candidate-screen-v1.json#pareto"],
    },
  ],
  [
    "monotonicity_threshold_proof",
    {
      execution: "completed",
      grade: structure.monotonicity.adoption.grade,
      prerequisitePassed: structure.monotonicity.adoption.grade === "product_candidate",
      reason: structure.monotonicity.adoption.reason,
      evidence: ["structure-candidate-screen-v1.json#monotonicity"],
    },
  ],
  [
    "symbolic_decision_diagram",
    {
      execution: "completed",
      grade: structure.symbolic.adoption.grade,
      prerequisitePassed: structure.symbolic.adoption.grade === "product_candidate",
      reason: structure.symbolic.adoption.reason,
      evidence: ["structure-candidate-screen-v1.json#symbolic"],
    },
  ],
]);
const decisions = buildResearchDecisionLedger(evidence);
const evidenceFiles = [
  "benchmarks/results/webgpu-compact-frontier-v1.json",
  "benchmarks/results/webgpu-frontier-android-v1.json",
  "benchmarks/results/certified-limited-depth-v1.json",
  "benchmarks/results/compact-lp-oracle-v1.json",
  "benchmarks/results/structure-candidate-screen-v1.json",
].map((path) => fingerprintResearchArtifact(REPO_ROOT, path));
const provenance = collectResearchProvenance({
  repoRoot: REPO_ROOT,
  studyId: CONTRACT.kind,
  protocolVersion: CONTRACT.version,
  contract: CONTRACT,
  sourceFiles: [
    "benchmarks/compact-exact-graph.ts",
    "benchmarks/complete-policy-oracle.ts",
    "benchmarks/next-solver-research-contract.ts",
    "benchmarks/next-solver-research-ledger.ts",
    "benchmarks/run-next-solver-research-finalize.ts",
  ],
});
const existing = readOptionalResearchReport(OUTPUT);
assertResearchReportCanBeWritten(existing, provenance);
const report = {
  kind: CONTRACT.kind,
  version: CONTRACT.version,
  provenance,
  contract: CONTRACT,
  evidenceFiles,
  completePolicyOracle: completeOracle,
  decisions,
  productDecision: {
    adoptedCandidate: null,
    productRuntimeChanged: false,
    reason: "No candidate passed its pre-registered exact, quality, device, and performance gates.",
  },
};
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      output: OUTPUT,
      completePolicyOracle: completeOracle,
      decisions: decisions.map(({ id, execution, grade, prerequisitePassed, blockers }) => ({
        id,
        execution,
        grade,
        prerequisitePassed,
        blockers,
      })),
      productDecision: report.productDecision,
    },
    null,
    2,
  ),
);
