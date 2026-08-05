import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "vite";
import { classifyMcExactCalibration } from "./rerank-quality.ts";
import { envValue } from "./runner-utils.ts";
import {
  parseRustBenchmarkWeightSpec,
  rustBenchmarkWeightForScenario,
} from "./rust-benchmark-weights.ts";
import {
  compareA1ForActions,
  compareA2ForActions,
  evaluateAdaptive90Gate,
} from "./rust-rerank-benchmark-actions.ts";
import {
  buildRustRerankBenchmarkReport,
  rustRerankBenchmarkConsoleSummary,
  writeRustRerankBenchmarkReport,
} from "./rust-rerank-benchmark-report.ts";
import {
  type BenchmarkScenario,
  DEFAULT_A1_SENTINEL_IDS,
  DEFAULT_EVALUATION_SEEDS,
  DEFAULT_HELD_OUT_SEED,
  DEFAULT_RUNS,
  DEFAULT_SEED,
  HORIZON_FACTOR,
  NORM_POWER,
  parseIntegerList,
  parseList,
  parsePositiveInteger,
  parseSources,
  stateLabel,
  summarizeEvaluationPairs,
  TOLERANCE,
} from "./rust-rerank-benchmark-utils.ts";
import { emptyScenarioRecord } from "./rust-rerank-records.ts";
import {
  type ScenarioRecord,
  RUST_RERANK_STRICT_EPSILON as STRICT_EPSILON,
} from "./rust-rerank-summary-model.ts";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const JSON_OUTPUT_FILE = new URL("./results/rust-rerank-benchmark.json", import.meta.url);
const CSV_OUTPUT_FILE = new URL("./results/rust-rerank-benchmark.csv", import.meta.url);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);

const runs = parsePositiveInteger(envValue("RUST_RERANK_BENCH_RUNS"), DEFAULT_RUNS);
const seed = parsePositiveInteger(envValue("RUST_RERANK_BENCH_SEED"), DEFAULT_SEED);
const heldOutSeed = parsePositiveInteger(
  envValue("RUST_RERANK_BENCH_HELD_OUT_SEED"),
  DEFAULT_HELD_OUT_SEED,
);
const evaluationSeeds = parseIntegerList(
  envValue("RUST_RERANK_BENCH_EVAL_SEEDS"),
  DEFAULT_EVALUATION_SEEDS,
);
const a1SentinelIds = new Set(
  parseList(envValue("RUST_RERANK_BENCH_A1_SENTINELS"), DEFAULT_A1_SENTINEL_IDS),
);
const weightSpec = parseRustBenchmarkWeightSpec(
  envValue("RUST_RERANK_BENCH_WEIGHTS"),
  envValue("RUST_RERANK_BENCH_WEIGHT_PROFILE"),
);
await mkdir(RESULTS_DIRECTORY, { recursive: true });

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

const rustResearch = (await server.ssrLoadModule(
  "/src/wasm/rustResearchLoader.ts",
)) as typeof import("../src/wasm/rustResearchLoader");
const rustLoader = (await server.ssrLoadModule(
  "/src/wasm/rustLoader.ts",
)) as typeof import("../src/wasm/rustLoader");
const rustMinEf = (await server.ssrLoadModule(
  "/src/wasm/rustMinEfCore.ts",
)) as typeof import("../src/wasm/rustMinEfCore");
const rustStatus = (await server.ssrLoadModule(
  "/src/wasm/rustStatus.ts",
)) as typeof import("../src/wasm/rustStatus");
const fixedGrid = (await server.ssrLoadModule(
  "/benchmarks/scenarios/fixed-grid.ts",
)) as typeof import("./scenarios/fixed-grid");
const supplemental = (await server.ssrLoadModule(
  "/benchmarks/scenarios/rerank-supplemental.ts",
)) as typeof import("./scenarios/rerank-supplemental");
const productObserved = (await server.ssrLoadModule(
  "/benchmarks/scenarios/rerank-product.ts",
)) as typeof import("./scenarios/rerank-product");

const requestedSources = parseSources(envValue("RUST_RERANK_BENCH_SOURCES"));
const allScenarios: BenchmarkScenario[] = [
  ...(requestedSources.has("fixed-grid")
    ? fixedGrid.FIXED_SAFETY_GRID.map((scenario) => ({
        ...scenario,
        source: "fixed-grid" as const,
      }))
    : []),
  ...(requestedSources.has("gain28-supplemental")
    ? supplemental.RERANK_SUPPLEMENTAL_SCENARIOS.map((scenario) => ({
        ...scenario,
        source: "gain28-supplemental" as const,
      }))
    : []),
  ...(requestedSources.has("product-observed") ||
  requestedSources.has("product-observed-high-stock")
    ? productObserved.PRODUCT_RERANK_SCENARIOS.map((scenario) => ({
        ...scenario,
        source: scenario.productSource,
      })).filter((scenario) => requestedSources.has(scenario.source))
    : []),
];
const byId = new Map(allScenarios.map((scenario) => [scenario.id, scenario]));
const scenarioIds = parseList(
  envValue("RUST_RERANK_BENCH_SCENARIOS"),
  allScenarios.map((scenario) => scenario.id),
);
const scenarios = scenarioIds.map((id) => {
  const scenario = byId.get(id);
  if (!scenario) {
    throw new Error(
      `Missing rust rerank benchmark scenario: ${id}. Known scenarios: ${[...byId.keys()].join(", ")}`,
    );
  }
  return scenario;
});

const records: ScenarioRecord[] = [];
const startedAt = performance.now();

try {
  const wasm = await readFile(WASM_URL);
  const instantiated = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  const instance =
    instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
  const solver = rustResearch.createRustPhase2ResearchSolverFromInstance(instance);
  const minEfInstantiated = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  const minEfInstance =
    minEfInstantiated instanceof WebAssembly.Instance
      ? minEfInstantiated
      : minEfInstantiated.instance;
  const minEfSolver = rustMinEf.createRustMinEfSolver(
    rustLoader.rustCoreExportsFromInstance(minEfInstance),
  );

  for (const scenario of scenarios) {
    const scenarioStartedAt = performance.now();
    const common = {
      scenarioId: scenario.id,
      source: scenario.source,
      group: scenario.group,
      weight: rustBenchmarkWeightForScenario(scenario, weightSpec),
      start: stateLabel(scenario),
      stockBlue: scenario.stock.blue,
      stockPurple: scenario.stock.purple,
      stockYellow: scenario.stock.yellow,
    };
    let minEfOutcome: ScenarioRecord["minEfOutcome"] = "failure";
    let minEfFirstAction: string | null = null;
    let minEfSuccessProbability: number | null = null;
    let minEfExpectedCost: number | null = null;
    let minEfTotalExpectedUses: number | null = null;
    let minEfNodeCount: number | null = null;
    let minEfErrorMessage: string | null = null;
    try {
      const minEfPolicy = minEfSolver.solveRootWithCandidates(
        scenario.start,
        scenario.stock,
        HORIZON_FACTOR,
        NORM_POWER,
        TOLERANCE,
      );
      minEfOutcome = "completed";
      minEfFirstAction = minEfPolicy.root.firstAction;
      minEfSuccessProbability = minEfPolicy.root.successProbability;
      minEfExpectedCost = minEfPolicy.root.expectedCost;
      minEfTotalExpectedUses =
        (minEfPolicy.root.vector.blue +
          minEfPolicy.root.vector.purple +
          minEfPolicy.root.vector.yellow) /
        10;
      minEfNodeCount = minEfPolicy.nodeCount;
    } catch (error) {
      minEfErrorMessage = error instanceof Error ? error.message : String(error);
      if (error instanceof rustStatus.RustSolveError) {
        minEfNodeCount = error.nodeCount;
        if (error.status === rustStatus.RUST_STATUS_MEMO_FULL) minEfOutcome = "memo_full";
        else if (error.status === rustStatus.RUST_STATUS_BUDGET_EXCEEDED) {
          minEfOutcome = "budget_exceeded";
        }
      }
    }
    try {
      const rerank = solver.selectFirstActionByExpectedCost(
        scenario.start,
        scenario.stock,
        runs,
        seed,
        HORIZON_FACTOR,
        NORM_POWER,
        TOLERANCE,
      );
      if (!rerank?.baseline.firstAction || !rerank.selected.firstAction) {
        records.push(
          emptyScenarioRecord(
            common,
            "no-action",
            Math.round(performance.now() - scenarioStartedAt),
            {
              candidateCount: rerank?.candidates.length ?? 0,
              baselineFirstAction: rerank?.baseline.firstAction ?? null,
              selectedFirstAction: rerank?.selected.firstAction ?? null,
              baselineSuccessProbability: rerank?.baseline.successProbability ?? null,
              selectedSuccessProbability: rerank?.selected.successProbability ?? null,
              selectedProbabilityGap: rerank?.selected.probabilityGap ?? null,
              inSampleSelectedExpectedCost: rerank?.selected.expectedCost ?? null,
              inSampleCompletionRate: rerank?.selected.completionRate ?? null,
            },
          ),
        );
        continue;
      }
      const baselineFirstAction = rerank.baseline.firstAction;
      const selectedFirstAction = rerank.selected.firstAction;

      const baselineCandidate = rerank.candidates.find(
        (candidate) => candidate.firstAction === baselineFirstAction,
      );
      const baselineInSample =
        baselineCandidate ??
        solver.estimateExpectedCostAfterFirstActionFromCurrent(
          scenario.start,
          scenario.stock,
          baselineFirstAction,
          runs,
          seed,
          HORIZON_FACTOR,
          NORM_POWER,
        );
      const heldOutSelected = solver.estimateExpectedCostAfterFirstActionFromCurrent(
        scenario.start,
        scenario.stock,
        selectedFirstAction,
        runs,
        heldOutSeed,
        HORIZON_FACTOR,
        NORM_POWER,
      );
      const heldOutBaseline =
        baselineFirstAction === selectedFirstAction
          ? heldOutSelected
          : solver.estimateExpectedCostAfterFirstActionFromCurrent(
              scenario.start,
              scenario.stock,
              baselineFirstAction,
              runs,
              heldOutSeed,
              HORIZON_FACTOR,
              NORM_POWER,
            );
      const heldOutDelta = heldOutSelected.expectedCost - heldOutBaseline.expectedCost;
      const gatePair = solver.estimateExpectedCostPairFromCurrent(
        scenario.start,
        scenario.stock,
        baselineFirstAction,
        selectedFirstAction,
        runs,
        heldOutSeed,
        HORIZON_FACTOR,
        NORM_POWER,
      );
      const evaluationPairs = evaluationSeeds.map((evaluationSeed) =>
        solver.estimateExpectedCostPairFromCurrent(
          scenario.start,
          scenario.stock,
          baselineFirstAction,
          selectedFirstAction,
          runs,
          evaluationSeed,
          HORIZON_FACTOR,
          NORM_POWER,
        ),
      );
      const evaluation = summarizeEvaluationPairs(evaluationPairs);
      const twoFoldGatePass = gatePair.meanDelta <= STRICT_EPSILON;
      const paired95GatePass = gatePair.upper95 < 0;
      const evaluationSelectedImproves = evaluation.meanDelta < -STRICT_EPSILON;
      const evaluationSelectedWorsens = evaluation.meanDelta > STRICT_EPSILON;
      const rawIntervened = baselineFirstAction !== selectedFirstAction;
      const twoFoldIntervened = rawIntervened && twoFoldGatePass;
      const paired95Intervened = rawIntervened && paired95GatePass;
      const adaptive90 = evaluateAdaptive90Gate({
        solver,
        scenario,
        seed,
        heldOutSeed,
        evaluationSeeds,
      });
      const a2 = compareA2ForActions({
        solver,
        scenario,
        baselineFirstAction,
        selectedFirstAction,
      });
      const a1 = compareA1ForActions({
        solver,
        scenario,
        baselineFirstAction,
        selectedFirstAction,
        enabled: true,
      });
      let exactSelectedFirstAction: string | null = null;
      let exactIntervened = false;
      let exactBaselineExpectedCost: number | null = null;
      let exactSelectedExpectedCost: number | null = null;
      let exactDeltaVsBaseline: number | null = null;
      let exactNodeCount: number | null = null;
      let exactErrorMessage: string | null = null;
      try {
        const exactRerank = solver.selectFirstActionByExactExpectedCost(
          scenario.start,
          scenario.stock,
          HORIZON_FACTOR,
          NORM_POWER,
          TOLERANCE,
        );
        const exactBaseline = exactRerank?.candidates.find(
          (candidate) => candidate.firstAction === exactRerank.baseline.firstAction,
        );
        if (exactRerank && exactBaseline) {
          exactSelectedFirstAction = exactRerank.selected.firstAction;
          exactIntervened = exactSelectedFirstAction !== exactRerank.baseline.firstAction;
          exactBaselineExpectedCost = exactBaseline.expectedCost;
          exactSelectedExpectedCost = exactRerank.selected.expectedCost;
          exactDeltaVsBaseline = exactSelectedExpectedCost - exactBaselineExpectedCost;
          exactNodeCount = Math.max(
            ...exactRerank.candidates.map((candidate) => candidate.nodeCount),
          );
        }
      } catch (error) {
        exactErrorMessage = error instanceof Error ? error.message : String(error);
      }
      const mcExact = classifyMcExactCalibration(
        evaluation.meanDelta,
        evaluation.standardError,
        a1.deltaVsBaseline,
      );
      const a2GatePass = a2.deltaVsBaseline === null ? null : a2.deltaVsBaseline < -STRICT_EPSILON;
      const a2GateIntervened = rawIntervened && a2GatePass === true;
      const a2GateEvaluationDeltaVsBaseline =
        a2GatePass === null ? null : a2GateIntervened ? evaluation.meanDelta : 0;
      const a2GateFalsePositive =
        a2GatePass === null ? null : a2GateIntervened ? evaluationSelectedWorsens : false;
      const a2GateFalseNegative =
        a2GatePass === null
          ? null
          : rawIntervened && !a2GatePass
            ? evaluationSelectedImproves
            : false;

      records.push({
        ...common,
        status: "completed",
        minEfOutcome,
        minEfFirstAction,
        minEfSuccessProbability,
        minEfExpectedCost,
        minEfTotalExpectedUses,
        minEfNodeCount,
        minEfErrorMessage,
        candidateCount: rerank.candidates.length,
        baselineFirstAction,
        selectedFirstAction,
        intervened: rerank.baseline.firstAction !== rerank.selected.firstAction,
        baselineSuccessProbability: rerank.baseline.successProbability,
        selectedSuccessProbability: rerank.selected.successProbability,
        selectedProbabilityGap: rerank.selected.probabilityGap,
        selectedProbabilityLossVsBaseline:
          rerank.baseline.successProbability - rerank.selected.successProbability,
        inSampleBaselineExpectedCost: baselineInSample.expectedCost,
        inSampleSelectedExpectedCost: rerank.selected.expectedCost,
        inSampleDeltaVsBaseline: rerank.selected.expectedCost - baselineInSample.expectedCost,
        inSampleCompletionRate: rerank.selected.completionRate,
        heldOutBaselineExpectedCost: heldOutBaseline.expectedCost,
        heldOutSelectedExpectedCost: heldOutSelected.expectedCost,
        heldOutDeltaVsBaseline: heldOutDelta,
        heldOutBaselineCompletionRate: heldOutBaseline.completionRate,
        heldOutSelectedCompletionRate: heldOutSelected.completionRate,
        heldOutNonWorse: heldOutDelta <= STRICT_EPSILON,
        heldOutStrictImproved: heldOutDelta < -STRICT_EPSILON,
        rawEvaluationDeltaVsBaseline: rawIntervened ? evaluation.meanDelta : 0,
        rawEvaluationStandardError: evaluation.standardError,
        rawEvaluationUpper95: evaluation.upper95,
        rawEvaluationSeedSpread: evaluation.seedSpread,
        twoFoldGatePass,
        twoFoldIntervened,
        twoFoldEvaluationDeltaVsBaseline: twoFoldIntervened ? evaluation.meanDelta : 0,
        twoFoldFalsePositive: twoFoldIntervened ? evaluationSelectedWorsens : false,
        twoFoldFalseNegative:
          rawIntervened && !twoFoldGatePass ? evaluationSelectedImproves : false,
        paired95GatePass,
        paired95Intervened,
        paired95EvaluationDeltaVsBaseline: paired95Intervened ? evaluation.meanDelta : 0,
        paired95FalsePositive: paired95Intervened ? evaluationSelectedWorsens : false,
        paired95FalseNegative:
          rawIntervened && !paired95GatePass ? evaluationSelectedImproves : false,
        adaptive90RawSelectedFirstAction: adaptive90.rawSelectedFirstAction,
        adaptive90SelectedFirstAction: adaptive90.selectedFirstAction,
        adaptive90GatePass: adaptive90.gatePass,
        adaptive90Intervened: adaptive90.intervened,
        adaptive90EvaluationDeltaVsBaseline: adaptive90.evaluationDeltaVsBaseline,
        adaptive90FalsePositive: adaptive90.falsePositive,
        adaptive90FalseNegative: adaptive90.falseNegative,
        adaptive90GateRuns: adaptive90.gateRuns,
        adaptive90GateMeanDelta: adaptive90.gateMeanDelta,
        adaptive90GateStandardError: adaptive90.gateStandardError,
        adaptive90GateUpperBound: adaptive90.gateUpperBound,
        adaptive90GateCorrelation: adaptive90.gateCorrelation,
        a2GatePass,
        a2GateIntervened,
        a2GateEvaluationDeltaVsBaseline,
        a2GateFalsePositive,
        a2GateFalseNegative,
        gatePairMeanDelta: gatePair.meanDelta,
        gatePairStandardError: gatePair.standardError,
        gatePairUpper95: gatePair.upper95,
        gatePairCorrelation: gatePair.correlation,
        a2BaselineSurrogateCost: a2.baselineCost,
        a2SelectedSurrogateCost: a2.selectedCost,
        a2DeltaVsBaseline: a2.deltaVsBaseline,
        a2NodeCount: a2.nodeCount,
        a2ErrorMessage: a2.errorMessage,
        a1BaselineExactCost: a1.baselineCost,
        a1SelectedExactCost: a1.selectedCost,
        a1DeltaVsBaseline: a1.deltaVsBaseline,
        a1NodeCount: a1.nodeCount,
        a1ErrorMessage: a1.errorMessage,
        exactSelectedFirstAction,
        exactIntervened,
        exactBaselineExpectedCost,
        exactSelectedExpectedCost,
        exactDeltaVsBaseline,
        exactNodeCount,
        exactErrorMessage,
        mcExactCalibration: mcExact.classification,
        mcExactStandardizedError: mcExact.standardizedError,
        elapsedMs: Math.round(performance.now() - scenarioStartedAt),
      });
    } catch (error) {
      records.push(
        emptyScenarioRecord(common, "error", Math.round(performance.now() - scenarioStartedAt), {
          errorMessage: error instanceof Error ? error.message : String(error),
          minEfOutcome,
          minEfFirstAction,
          minEfSuccessProbability,
          minEfExpectedCost,
          minEfTotalExpectedUses,
          minEfNodeCount,
          minEfErrorMessage,
        }),
      );
    }
  }

  const report = buildRustRerankBenchmarkReport({
    elapsedMs: Math.round(performance.now() - startedAt),
    options: {
      runs,
      seed,
      heldOutSeed,
      evaluationSeeds,
      a1SentinelIds: [...a1SentinelIds],
      weightSpec,
      horizonFactor: HORIZON_FACTOR,
      normPower: NORM_POWER,
      tolerance: TOLERANCE,
      sources: [...requestedSources],
      scenarioIds,
    },
    records,
  });
  await writeRustRerankBenchmarkReport({
    jsonOutputFile: JSON_OUTPUT_FILE,
    csvOutputFile: CSV_OUTPUT_FILE,
    report,
  });

  console.log(
    JSON.stringify(
      rustRerankBenchmarkConsoleSummary({
        report,
        jsonOutputFile: JSON_OUTPUT_FILE,
        csvOutputFile: CSV_OUTPUT_FILE,
      }),
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
