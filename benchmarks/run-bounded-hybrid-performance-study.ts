import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { SolverInput } from "../src/types";
import { summarizePhaseLatencySamples } from "./latency-report.ts";
import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  fingerprintResearchArtifact,
  type ResearchProvenance,
} from "./research-provenance.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRODUCT_WASM_PATH = "public/solver_rs.wasm";
const CANDIDATE_WASM_PATH = "output/solver_rs-prioritized-sparse-pi.wasm";
const OUTPUT_URL = new URL("./results/bounded-hybrid-performance-study-v2.json", import.meta.url);
const SCENARIO_IDS = ["R10-balanced300", "SR0-balanced300"] as const;
const CONTRACT = {
  objective: "compare_phase2_and_bounded_prioritized_fallback_root_latency",
  baseline: "rust-phase2-tier22-root",
  candidate: "max-path-prioritized-phase2-root",
  commonMinEfRung: "excluded_because_identical_between_ladders_and_covered_by_exact_quality_study",
  candidateOptions: {
    horizonFactor: 0.75,
    maxPasses: 4,
    maxStates: 1_200_000,
    maxUpdatesPerPass: 256,
    memoTier: 22,
    normPower: 3,
    priorityMode: "max_path_probability",
    tolerance: 0,
  },
  campaigns: 2,
  repeatsPerCampaign: 31,
  order: "ABBA",
  preparationRuns: 1,
  scenarioIds: SCENARIO_IDS,
  latencyGate: {
    id: "allocation_warm_p95_max_relative_or_absolute_v1",
    relativeFactor: 1.15,
    absoluteMarginMs: 50,
  },
  productWasmBudgetBytes: 115_000,
  successEpsilon: 1e-12,
} as const;

type CandidateModule = typeof import("./rust-prioritized-sparse-pi");
type CandidateResult = ReturnType<CandidateModule["solveRustPrioritizedSparsePi"]>;
type Phase2Root = ReturnType<
  ReturnType<
    typeof import("../src/wasm/rustPhase2ResearchCore")["createRustPhase2ResearchSolver"]
  >["solveRoot"]
>;

type Report = {
  kind: "bounded-hybrid-performance-study";
  version: 2;
  generatedAt: string;
  provenance: ResearchProvenance;
  productWasm: ReturnType<typeof fingerprintResearchArtifact>;
  contract: typeof CONTRACT;
  records: Array<{
    scenarioId: string;
    campaign: number;
    baseline: ReturnType<typeof summarizePhaseLatencySamples>;
    candidate: ReturnType<typeof summarizePhaseLatencySamples>;
    baselinePreparationMs: number;
    candidatePreparationMs: number;
    baselineSignature: string;
    candidateSignature: string;
    baselineStable: boolean;
    candidateStable: boolean;
    candidateInvariantPassed: boolean;
    p95LimitMs: number;
    p95Ratio: number;
    latencyGatePassed: boolean;
  }>;
  decision: {
    latencyGatePassed: boolean;
    deterministicOutcomes: boolean;
    candidateInvariantPassed: boolean;
    sizeGatePassed: boolean;
    productAdoptionAuthorized: false;
    blockers: string[];
  };
};

async function main() {
  const provenance = collectResearchProvenance({
    repoRoot: REPO_ROOT,
    studyId: "bounded-hybrid-performance-study-v2",
    protocolVersion: 2,
    contract: CONTRACT,
    sourceFiles: [
      "benchmarks/latency-report.ts",
      "benchmarks/research-provenance.ts",
      "benchmarks/run-bounded-hybrid-performance-study.ts",
      "benchmarks/rust-prioritized-sparse-pi.ts",
      "benchmarks/scenarios/fixed-grid.ts",
      "rust/solver-rs/src/prioritized_sparse_pi.rs",
      "src/wasm/rustCoreExports.ts",
      "src/wasm/rustLoader.ts",
      "src/wasm/rustPhase2ResearchCore.ts",
    ],
    wasmPath: CANDIDATE_WASM_PATH,
  });
  assertResearchReportCanBeWritten(await readExistingReport(), provenance);
  const [productWasmBytes, candidateWasmBytes] = await Promise.all([
    readFile(new URL(`../${PRODUCT_WASM_PATH}`, import.meta.url)),
    readFile(new URL(`../${CANDIDATE_WASM_PATH}`, import.meta.url)),
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
    const phase2Module = (await server.ssrLoadModule(
      "/src/wasm/rustPhase2ResearchCore.ts",
    )) as typeof import("../src/wasm/rustPhase2ResearchCore");
    const candidateModule = (await server.ssrLoadModule(
      "/benchmarks/rust-prioritized-sparse-pi.ts",
    )) as CandidateModule;
    const fixed = (await server.ssrLoadModule(
      "/benchmarks/scenarios/fixed-grid.ts",
    )) as typeof import("./scenarios/fixed-grid");
    const scenarios = new Map(fixed.FIXED_SAFETY_GRID.map((scenario) => [scenario.id, scenario]));
    const records: Report["records"] = [];

    for (const scenarioId of SCENARIO_IDS) {
      const scenario = scenarios.get(scenarioId);
      if (!scenario) throw new Error(`Missing bounded-hybrid scenario: ${scenarioId}.`);
      const input: SolverInput = {
        start: scenario.start,
        stock: scenario.stock,
        strategy: "supply",
      };

      for (let campaign = 1; campaign <= CONTRACT.campaigns; campaign += 1) {
        const phase2 = phase2Module.createRustPhase2ResearchSolver(
          loader.rustCoreExportsFromInstance(await instantiate(productWasmBytes)),
        );
        phase2.configureMemoTier(22);
        const candidateExports = loader.rustCoreExportsFromInstance(
          await instantiate(candidateWasmBytes),
        );
        const solveBaseline = () => phase2.solveRoot(scenario.start, scenario.stock, 0.75, 3, 0);
        const solveCandidate = () =>
          candidateModule.solveRustPrioritizedSparsePi(
            candidateExports,
            input,
            CONTRACT.candidateOptions,
          );
        const baselinePreparation = measure(solveBaseline);
        const candidatePreparation = measure(solveCandidate);
        const baselineSamples: number[] = [];
        const candidateSamples: number[] = [];
        const baselineSignatures: string[] = [];
        const candidateSignatures: string[] = [];
        let candidateInvariantPassed = candidateIsValid(candidatePreparation.result);

        for (let index = 0; index < CONTRACT.repeatsPerCampaign; index += 1) {
          const baseFirst = index % 2 === 0;
          if (baseFirst) {
            recordSample(solveBaseline, baselineSignature, baselineSamples, baselineSignatures);
            candidateInvariantPassed =
              recordSample(
                solveCandidate,
                candidateSignature,
                candidateSamples,
                candidateSignatures,
              ) && candidateInvariantPassed;
          } else {
            candidateInvariantPassed =
              recordSample(
                solveCandidate,
                candidateSignature,
                candidateSamples,
                candidateSignatures,
              ) && candidateInvariantPassed;
            recordSample(solveBaseline, baselineSignature, baselineSamples, baselineSignatures);
          }
        }

        const baseline = summarizePhaseLatencySamples(baselineSamples);
        const candidate = summarizePhaseLatencySamples(candidateSamples);
        const p95LimitMs = Math.max(
          baseline.p95Ms * CONTRACT.latencyGate.relativeFactor,
          baseline.p95Ms + CONTRACT.latencyGate.absoluteMarginMs,
        );
        records.push({
          scenarioId,
          campaign,
          baseline,
          candidate,
          baselinePreparationMs: baselinePreparation.elapsedMs,
          candidatePreparationMs: candidatePreparation.elapsedMs,
          baselineSignature: baselineSignatures[0] ?? "missing",
          candidateSignature: candidateSignatures[0] ?? "missing",
          baselineStable: new Set(baselineSignatures).size === 1,
          candidateStable: new Set(candidateSignatures).size === 1,
          candidateInvariantPassed,
          p95LimitMs,
          p95Ratio: candidate.p95Ms / baseline.p95Ms,
          latencyGatePassed: candidate.p95Ms <= p95LimitMs,
        });
        phase2.releaseMemo();
        candidateExports.releasePhase2Memo?.();
        console.log(
          `${scenarioId} campaign ${campaign}: base=${baseline.p95Ms.toFixed(2)}ms ` +
            `candidate=${candidate.p95Ms.toFixed(2)}ms ratio=${(
              candidate.p95Ms / baseline.p95Ms
            ).toFixed(3)}`,
        );
      }
    }

    const decision = summarizeDecision(records, candidateWasmBytes.byteLength);
    const report: Report = {
      kind: "bounded-hybrid-performance-study",
      version: 2,
      generatedAt: new Date().toISOString(),
      provenance,
      productWasm: fingerprintResearchArtifact(REPO_ROOT, PRODUCT_WASM_PATH),
      contract: CONTRACT,
      records,
      decision,
    };
    await writeFile(OUTPUT_URL, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report.decision));
  } finally {
    await server.close();
  }
}

function summarizeDecision(
  records: Report["records"],
  candidateWasmBytes: number,
): Report["decision"] {
  const latencyGatePassed = records.every((record) => record.latencyGatePassed);
  const deterministicOutcomes = records.every(
    (record) => record.baselineStable && record.candidateStable,
  );
  const candidateInvariantPassed = records.every((record) => record.candidateInvariantPassed);
  const sizeGatePassed = candidateWasmBytes <= CONTRACT.productWasmBudgetBytes;
  const blockers: string[] = [];
  for (const record of records) {
    if (!record.latencyGatePassed) {
      blockers.push(
        `${record.scenarioId} campaign ${record.campaign}: candidate p95 ` +
          `${record.candidate.p95Ms}ms exceeds ${record.p95LimitMs}ms.`,
      );
    }
    if (!record.baselineStable || !record.candidateStable) {
      blockers.push(`${record.scenarioId} campaign ${record.campaign}: unstable output.`);
    }
    if (!record.candidateInvariantPassed) {
      blockers.push(
        `${record.scenarioId} campaign ${record.campaign}: candidate invariant failed.`,
      );
    }
  }
  if (!sizeGatePassed) {
    blockers.push(
      `Candidate WASM is ${candidateWasmBytes} bytes, over the ` +
        `${CONTRACT.productWasmBudgetBytes}-byte product budget.`,
    );
  }
  return {
    latencyGatePassed,
    deterministicOutcomes,
    candidateInvariantPassed,
    sizeGatePassed,
    productAdoptionAuthorized: false,
    blockers,
  };
}

function candidateIsValid(result: CandidateResult): boolean {
  return (
    result.outcome === "iteration_budget_exceeded" &&
    result.probabilityGap <= CONTRACT.successEpsilon &&
    result.successInvariantChecks > 0 &&
    result.successInvariantMaxGap <= CONTRACT.successEpsilon
  );
}

function baselineSignature(result: Phase2Root): string {
  return JSON.stringify({
    firstAction: result.firstAction,
    successProbability: result.successProbability,
    vector: result.vector,
  });
}

function candidateSignature(result: CandidateResult): string {
  return JSON.stringify({
    outcome: result.outcome,
    finalAction: result.finalAction,
    success: result.success,
    cost: result.cost,
    vector: result.vector,
  });
}

function measure<T>(run: () => T) {
  const startedAt = performance.now();
  const result = run();
  return { elapsedMs: performance.now() - startedAt, result };
}

function recordSample<T>(
  solve: () => T,
  signature: (result: T) => string,
  samples: number[],
  signatures: string[],
): boolean {
  const measured = measure(solve);
  samples.push(measured.elapsedMs);
  signatures.push(signature(measured.result));
  return "outcome" in (measured.result as object)
    ? candidateIsValid(measured.result as CandidateResult)
    : true;
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
