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
import type { ScenarioRecord } from "./rust-rerank-summary-model.ts";

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
