import { writeFile } from "node:fs/promises";
import type { RustBenchmarkWeightSpec } from "./rust-benchmark-weights.ts";
import { serializeRustBenchmarkWeightSpec } from "./rust-benchmark-weights.ts";
import {
  ADAPTIVE_FULL_ACCEPT_MARGIN,
  ADAPTIVE_GATE_Z,
  ADAPTIVE_MAX_RUNS,
  ADAPTIVE_QUICK_ACCEPT_MARGIN,
  ADAPTIVE_QUICK_RUNS,
  csvEscape,
} from "./rust-rerank-benchmark-utils.ts";
import { summarizeGateSweep } from "./rust-rerank-gate-summary.ts";
import {
  summarize,
  summarizeA1,
  summarizeA2,
  summarizeBySource,
  summarizePairedDiagnostics,
  summarizePolicyDeltas,
} from "./rust-rerank-summary.ts";
import { RUST_RERANK_STRICT_EPSILON, type ScenarioRecord } from "./rust-rerank-summary-model.ts";

type RustRerankBenchmarkReportOptions = {
  runs: number;
  seed: number;
  heldOutSeed: number;
  evaluationSeeds: readonly number[];
  a1SentinelIds: readonly string[];
  weightSpec: RustBenchmarkWeightSpec;
  horizonFactor: number;
  normPower: number;
  tolerance: number;
  sources: readonly string[];
  scenarioIds: readonly string[];
};

type RustRerankBenchmarkReportArgs = {
  elapsedMs: number;
  options: RustRerankBenchmarkReportOptions;
  records: ScenarioRecord[];
};

function summarizeExactRerank(records: readonly ScenarioRecord[]) {
  const evaluated = records.filter((record) => record.exactDeltaVsBaseline !== null);
  return {
    evaluated: evaluated.length,
    errors: records.filter((record) => record.exactErrorMessage !== null).length,
    interventions: evaluated.filter((record) => record.exactIntervened).length,
    strictImprovements: evaluated.filter(
      (record) =>
        record.exactDeltaVsBaseline !== null &&
        record.exactDeltaVsBaseline < -RUST_RERANK_STRICT_EPSILON,
    ).length,
    regressions: evaluated.filter(
      (record) =>
        record.exactDeltaVsBaseline !== null &&
        record.exactDeltaVsBaseline > RUST_RERANK_STRICT_EPSILON,
    ).length,
    mcCalibration: {
      consistentWithSamplingError: records.filter(
        (record) => record.mcExactCalibration === "consistent_with_sampling_error",
      ).length,
      outsideNominal95Interval: records.filter(
        (record) => record.mcExactCalibration === "outside_nominal_95_interval",
      ).length,
      unavailable: records.filter((record) => record.mcExactCalibration === "unavailable").length,
    },
  };
}

function summarizeMinEfOutcomes(records: readonly ScenarioRecord[]) {
  return {
    completed: records.filter((record) => record.minEfOutcome === "completed").length,
    memoFull: records.filter((record) => record.minEfOutcome === "memo_full").length,
    budgetExceeded: records.filter((record) => record.minEfOutcome === "budget_exceeded").length,
    failure: records.filter((record) => record.minEfOutcome === "failure").length,
  };
}

function summarizeMinEfOptimality(records: readonly ScenarioRecord[]) {
  const comparable = records.filter(
    (record) =>
      record.minEfOutcome === "completed" &&
      record.minEfExpectedCost !== null &&
      record.exactSelectedExpectedCost !== null,
  );
  const exactBelowMinEf = comparable.filter(
    (record) =>
      (record.exactSelectedExpectedCost ?? 0) <
      (record.minEfExpectedCost ?? 0) - RUST_RERANK_STRICT_EPSILON,
  ).length;
  const exactAboveMinEf = comparable.filter(
    (record) =>
      (record.exactSelectedExpectedCost ?? 0) >
      (record.minEfExpectedCost ?? 0) + RUST_RERANK_STRICT_EPSILON,
  ).length;
  return {
    comparable: comparable.length,
    exactBelowMinEf,
    equalWithinEpsilon: comparable.length - exactBelowMinEf - exactAboveMinEf,
    exactAboveMinEf,
  };
}

export function buildRustRerankBenchmarkReport(args: RustRerankBenchmarkReportArgs) {
  const uniqueSources = [...new Set(args.records.map((record) => record.source))].sort();
  return {
    kind: "rust-rerank-benchmark",
    version: 1,
    generatedAt: new Date().toISOString(),
    elapsedMs: args.elapsedMs,
    options: {
      runs: args.options.runs,
      seed: args.options.seed,
      heldOutSeed: args.options.heldOutSeed,
      evaluationSeeds: args.options.evaluationSeeds,
      a1SentinelIds: args.options.a1SentinelIds,
      weightSpec: serializeRustBenchmarkWeightSpec(args.options.weightSpec),
      horizonFactor: args.options.horizonFactor,
      normPower: args.options.normPower,
      tolerance: args.options.tolerance,
      adaptive90: {
        quickRuns: ADAPTIVE_QUICK_RUNS,
        maxRuns: ADAPTIVE_MAX_RUNS,
        gateZ: ADAPTIVE_GATE_Z,
        quickAcceptMargin: ADAPTIVE_QUICK_ACCEPT_MARGIN,
        fullAcceptMargin: ADAPTIVE_FULL_ACCEPT_MARGIN,
      },
      sources: args.options.sources,
      scenarioIds: args.options.scenarioIds,
    },
    summary: summarize(args.records),
    policySummaries: summarizePolicyDeltas(args.records),
    policySummariesBySource: Object.fromEntries(
      uniqueSources.map((source) => [
        source,
        summarizePolicyDeltas(args.records.filter((record) => record.source === source)),
      ]),
    ),
    gateSweep: summarizeGateSweep(args.records),
    gateSweepBySource: Object.fromEntries(
      uniqueSources.map((source) => [
        source,
        summarizeGateSweep(args.records.filter((record) => record.source === source)),
      ]),
    ),
    pairedMcDiagnostics: {
      paired95Gate: summarizePairedDiagnostics(
        args.records,
        "gatePairStandardError",
        "gatePairCorrelation",
      ),
      adaptive90Gate: summarizePairedDiagnostics(
        args.records,
        "adaptive90GateStandardError",
        "adaptive90GateCorrelation",
        "adaptive90GateRuns",
        { quickRuns: ADAPTIVE_QUICK_RUNS, maxRuns: ADAPTIVE_MAX_RUNS },
      ),
    },
    a2Summary: summarizeA2(args.records),
    a1Summary: summarizeA1(args.records),
    exactRerankSummary: summarizeExactRerank(args.records),
    minEfOutcomes: summarizeMinEfOutcomes(args.records),
    minEfOptimality: summarizeMinEfOptimality(args.records),
    bySource: summarizeBySource(args.records),
    records: args.records,
  };
}

export type RustRerankBenchmarkReport = ReturnType<typeof buildRustRerankBenchmarkReport>;

export async function writeRustRerankBenchmarkReport(args: {
  jsonOutputFile: URL;
  csvOutputFile: URL;
  report: RustRerankBenchmarkReport;
}) {
  await writeFile(args.jsonOutputFile, `${JSON.stringify(args.report, null, 2)}\n`, "utf8");
  await writeFile(
    args.csvOutputFile,
    `${formatRustRerankBenchmarkCsv(args.report.records)}\n`,
    "utf8",
  );
}

export function rustRerankBenchmarkConsoleSummary(args: {
  report: RustRerankBenchmarkReport;
  jsonOutputFile: URL;
  csvOutputFile: URL;
}) {
  return {
    kind: args.report.kind,
    elapsedMs: args.report.elapsedMs,
    summary: args.report.summary,
    policySummaries: args.report.policySummaries,
    gateSweep: args.report.gateSweep,
    pairedMcDiagnostics: args.report.pairedMcDiagnostics,
    a2Summary: args.report.a2Summary,
    a1Summary: args.report.a1Summary,
    exactRerankSummary: args.report.exactRerankSummary,
    minEfOutcomes: args.report.minEfOutcomes,
    minEfOptimality: args.report.minEfOptimality,
    bySource: args.report.bySource,
    json: args.jsonOutputFile.pathname,
    csv: args.csvOutputFile.pathname,
  };
}

const RUST_RERANK_CSV_COLUMNS = [
  "scenarioId",
  "source",
  "group",
  "weight",
  "status",
  "start",
  "stockBlue",
  "stockPurple",
  "stockYellow",
  "minEfOutcome",
  "minEfFirstAction",
  "minEfSuccessProbability",
  "minEfExpectedCost",
  "minEfTotalExpectedUses",
  "minEfNodeCount",
  "minEfErrorMessage",
  "candidateCount",
  "baselineFirstAction",
  "selectedFirstAction",
  "intervened",
  "baselineSuccessProbability",
  "selectedSuccessProbability",
  "selectedProbabilityGap",
  "selectedProbabilityLossVsBaseline",
  "inSampleBaselineExpectedCost",
  "inSampleSelectedExpectedCost",
  "inSampleDeltaVsBaseline",
  "inSampleCompletionRate",
  "heldOutBaselineExpectedCost",
  "heldOutSelectedExpectedCost",
  "heldOutDeltaVsBaseline",
  "heldOutBaselineCompletionRate",
  "heldOutSelectedCompletionRate",
  "heldOutNonWorse",
  "heldOutStrictImproved",
  "rawEvaluationDeltaVsBaseline",
  "rawEvaluationStandardError",
  "rawEvaluationUpper95",
  "rawEvaluationSeedSpread",
  "twoFoldGatePass",
  "twoFoldIntervened",
  "twoFoldEvaluationDeltaVsBaseline",
  "twoFoldFalsePositive",
  "twoFoldFalseNegative",
  "paired95GatePass",
  "paired95Intervened",
  "paired95EvaluationDeltaVsBaseline",
  "paired95FalsePositive",
  "paired95FalseNegative",
  "adaptive90RawSelectedFirstAction",
  "adaptive90SelectedFirstAction",
  "adaptive90GatePass",
  "adaptive90Intervened",
  "adaptive90EvaluationDeltaVsBaseline",
  "adaptive90FalsePositive",
  "adaptive90FalseNegative",
  "adaptive90GateRuns",
  "adaptive90GateMeanDelta",
  "adaptive90GateStandardError",
  "adaptive90GateUpperBound",
  "adaptive90GateCorrelation",
  "a2GatePass",
  "a2GateIntervened",
  "a2GateEvaluationDeltaVsBaseline",
  "a2GateFalsePositive",
  "a2GateFalseNegative",
  "gatePairMeanDelta",
  "gatePairStandardError",
  "gatePairUpper95",
  "gatePairCorrelation",
  "a2BaselineSurrogateCost",
  "a2SelectedSurrogateCost",
  "a2DeltaVsBaseline",
  "a2NodeCount",
  "a2ErrorMessage",
  "a1BaselineExactCost",
  "a1SelectedExactCost",
  "a1DeltaVsBaseline",
  "a1NodeCount",
  "a1ErrorMessage",
  "exactSelectedFirstAction",
  "exactIntervened",
  "exactBaselineExpectedCost",
  "exactSelectedExpectedCost",
  "exactDeltaVsBaseline",
  "exactNodeCount",
  "exactErrorMessage",
  "mcExactCalibration",
  "mcExactStandardizedError",
  "elapsedMs",
] as const satisfies ReadonlyArray<keyof ScenarioRecord>;

function formatRustRerankBenchmarkCsv(records: readonly ScenarioRecord[]) {
  return [
    RUST_RERANK_CSV_COLUMNS.join(","),
    ...records.map((record) =>
      RUST_RERANK_CSV_COLUMNS.map((column) => csvEscape(record[column])).join(","),
    ),
  ].join("\n");
}
