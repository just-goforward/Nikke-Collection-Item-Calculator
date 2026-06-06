import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import type { RustCoreExports, RustPairedExpectedCostEstimate } from "../src/wasm/rustCore";
import {
  parseRustBenchmarkWeightSpec,
  type RustBenchmarkScenarioSource,
  rustBenchmarkWeightForScenario,
  serializeRustBenchmarkWeightSpec,
} from "./rust-benchmark-weights.ts";
import type { SolverScenario } from "./scenarios/fixed-grid";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const JSON_OUTPUT_FILE = new URL("./results/rust-rerank-benchmark.json", import.meta.url);
const CSV_OUTPUT_FILE = new URL("./results/rust-rerank-benchmark.csv", import.meta.url);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);

const HORIZON_FACTOR = 0.75;
const NORM_POWER = 3;
const TOLERANCE = 0;
const DEFAULT_RUNS = 2048;
const ADAPTIVE_QUICK_RUNS = 512;
const ADAPTIVE_MAX_RUNS = 2048;
const ADAPTIVE_GATE_Z = 1.645;
const ADAPTIVE_QUICK_ACCEPT_MARGIN = -0.001;
const ADAPTIVE_FULL_ACCEPT_MARGIN = -0.00025;
const DEFAULT_SEED = 20260509;
const DEFAULT_HELD_OUT_SEED = 20260510;
const DEFAULT_EVALUATION_SEEDS = [20260511, 20260512, 20260513, 20260514] as const;
const DEFAULT_A1_SENTINEL_IDS = [
  "SR10-balanced100",
  "SR10-blue10",
  "SR10-yellow10",
  "SR10-yellow30",
  "SR14e2900-balanced100",
] as const;
const STRICT_EPSILON = 1e-12;

type ScenarioSource = RustBenchmarkScenarioSource;

type BenchmarkScenario = SolverScenario & {
  source: ScenarioSource;
};

type ScenarioRecord = {
  scenarioId: string;
  source: ScenarioSource;
  group: string;
  weight: number;
  status: "completed" | "no-action" | "error";
  errorMessage?: string;
  start: string;
  stockBlue: number;
  stockPurple: number;
  stockYellow: number;
  candidateCount: number;
  baselineFirstAction: string | null;
  selectedFirstAction: string | null;
  intervened: boolean;
  baselineSuccessProbability: number | null;
  selectedSuccessProbability: number | null;
  selectedProbabilityGap: number | null;
  selectedProbabilityLossVsBaseline: number | null;
  inSampleBaselineExpectedCost: number | null;
  inSampleSelectedExpectedCost: number | null;
  inSampleDeltaVsBaseline: number | null;
  inSampleCompletionRate: number | null;
  heldOutBaselineExpectedCost: number | null;
  heldOutSelectedExpectedCost: number | null;
  heldOutDeltaVsBaseline: number | null;
  heldOutBaselineCompletionRate: number | null;
  heldOutSelectedCompletionRate: number | null;
  heldOutNonWorse: boolean | null;
  heldOutStrictImproved: boolean | null;
  rawEvaluationDeltaVsBaseline: number | null;
  rawEvaluationStandardError: number | null;
  rawEvaluationUpper95: number | null;
  rawEvaluationSeedSpread: number | null;
  twoFoldGatePass: boolean | null;
  twoFoldIntervened: boolean;
  twoFoldEvaluationDeltaVsBaseline: number | null;
  twoFoldFalsePositive: boolean | null;
  twoFoldFalseNegative: boolean | null;
  paired95GatePass: boolean | null;
  paired95Intervened: boolean;
  paired95EvaluationDeltaVsBaseline: number | null;
  paired95FalsePositive: boolean | null;
  paired95FalseNegative: boolean | null;
  adaptive90RawSelectedFirstAction: string | null;
  adaptive90SelectedFirstAction: string | null;
  adaptive90GatePass: boolean | null;
  adaptive90Intervened: boolean;
  adaptive90EvaluationDeltaVsBaseline: number | null;
  adaptive90FalsePositive: boolean | null;
  adaptive90FalseNegative: boolean | null;
  adaptive90GateRuns: number | null;
  adaptive90GateMeanDelta: number | null;
  adaptive90GateStandardError: number | null;
  adaptive90GateUpperBound: number | null;
  adaptive90GateCorrelation: number | null;
  a2GatePass: boolean | null;
  a2GateIntervened: boolean;
  a2GateEvaluationDeltaVsBaseline: number | null;
  a2GateFalsePositive: boolean | null;
  a2GateFalseNegative: boolean | null;
  gatePairMeanDelta: number | null;
  gatePairStandardError: number | null;
  gatePairUpper95: number | null;
  gatePairCorrelation: number | null;
  a2BaselineSurrogateCost: number | null;
  a2SelectedSurrogateCost: number | null;
  a2DeltaVsBaseline: number | null;
  a2NodeCount: number | null;
  a2ErrorMessage: string | null;
  a1BaselineExactCost: number | null;
  a1SelectedExactCost: number | null;
  a1DeltaVsBaseline: number | null;
  a1NodeCount: number | null;
  a1ErrorMessage: string | null;
  elapsedMs: number;
};

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function parseList(value: string | undefined, fallback: readonly string[]): string[] {
  const parsed = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
}

function parseIntegerList(value: string | undefined, fallback: readonly number[]): number[] {
  const parsed = String(value || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.trunc(item));
  return parsed.length > 0 ? parsed : [...fallback];
}

function parseSources(value: string | undefined): Set<ScenarioSource> {
  const parsed = new Set(
    String(value || "all")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (parsed.has("all"))
    return new Set([
      "fixed-grid",
      "gain28-supplemental",
      "product-observed",
      "product-observed-high-stock",
    ]);
  return new Set(
    [...parsed].filter(
      (source): source is ScenarioSource =>
        source === "fixed-grid" ||
        source === "gain28-supplemental" ||
        source === "product-observed" ||
        source === "product-observed-high-stock",
    ),
  );
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function stateLabel(scenario: SolverScenario) {
  const exp = scenario.start.exp ? `e${scenario.start.exp}` : "";
  return `${scenario.start.grade}${scenario.start.level}${exp}`;
}

function mean(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function weightedSum<T extends { weight: number }>(items: T[], valueFor: (item: T) => number) {
  return items.reduce((total, item) => total + valueFor(item) * item.weight, 0);
}

function summarizeDeltaRecords(
  records: ScenarioRecord[],
  deltaKey:
    | "rawEvaluationDeltaVsBaseline"
    | "twoFoldEvaluationDeltaVsBaseline"
    | "paired95EvaluationDeltaVsBaseline"
    | "adaptive90EvaluationDeltaVsBaseline"
    | "a2GateEvaluationDeltaVsBaseline",
  interventionKey:
    | "intervened"
    | "twoFoldIntervened"
    | "paired95Intervened"
    | "adaptive90Intervened"
    | "a2GateIntervened",
  falsePositiveKey?:
    | "twoFoldFalsePositive"
    | "paired95FalsePositive"
    | "adaptive90FalsePositive"
    | "a2GateFalsePositive",
  falseNegativeKey?:
    | "twoFoldFalseNegative"
    | "paired95FalseNegative"
    | "adaptive90FalseNegative"
    | "a2GateFalseNegative",
) {
  const completed = records.filter((record) => record.status === "completed");
  const comparable = completed.filter((record) => record[deltaKey] !== null);
  const deltas = comparable
    .map((record) => record[deltaKey])
    .filter((value): value is number => value !== null);
  const positive = deltas.filter((value) => value > STRICT_EPSILON);
  const negative = deltas.filter((value) => value < -STRICT_EPSILON);
  const interventions = completed.filter((record) => record[interventionKey]);
  const interventionDeltas = interventions
    .map((record) => record[deltaKey])
    .filter((value): value is number => value !== null);
  const comparableWeight = sum(comparable.map((record) => record.weight));
  const interventionWeight = sum(interventions.map((record) => record.weight));
  const weightedDeltaSum = weightedSum(comparable, (record) => record[deltaKey] ?? 0);
  const weightedInterventionDeltaSum = weightedSum(
    interventions,
    (record) => record[deltaKey] ?? 0,
  );
  return {
    comparableCount: comparable.length,
    interventionCount: interventions.length,
    interventionRate: completed.length > 0 ? interventions.length / completed.length : null,
    comparableWeight,
    interventionWeight,
    weightedInterventionRate: comparableWeight > 0 ? interventionWeight / comparableWeight : null,
    sumDelta: sum(deltas),
    meanDelta: mean(deltas),
    interventionSumDelta: sum(interventionDeltas),
    interventionMeanDelta: mean(interventionDeltas),
    weightedSumDelta: weightedDeltaSum,
    weightedMeanDelta: comparableWeight > 0 ? weightedDeltaSum / comparableWeight : null,
    weightedInterventionSumDelta: weightedInterventionDeltaSum,
    weightedInterventionMeanDelta:
      interventionWeight > 0 ? weightedInterventionDeltaSum / interventionWeight : null,
    positiveDeltaCount: positive.length,
    positiveDeltaSum: sum(positive),
    negativeDeltaCount: negative.length,
    negativeDeltaSum: sum(negative),
    falsePositiveCount: falsePositiveKey
      ? completed.filter((record) => record[falsePositiveKey]).length
      : null,
    falseNegativeCount: falseNegativeKey
      ? completed.filter((record) => record[falseNegativeKey]).length
      : null,
    worstPositiveDeltaTop: comparable
      .filter((record) => (record[deltaKey] ?? 0) > STRICT_EPSILON)
      .sort((a, b) => (b[deltaKey] ?? 0) - (a[deltaKey] ?? 0))
      .slice(0, 5)
      .map((record) => ({ scenarioId: record.scenarioId, delta: record[deltaKey] })),
    bestNegativeDeltaTop: comparable
      .filter((record) => (record[deltaKey] ?? 0) < -STRICT_EPSILON)
      .sort((a, b) => (a[deltaKey] ?? 0) - (b[deltaKey] ?? 0))
      .slice(0, 5)
      .map((record) => ({ scenarioId: record.scenarioId, delta: record[deltaKey] })),
  };
}

type SimulatedGateSpec = {
  key: string;
  description: string;
  pass: (record: ScenarioRecord) => boolean;
};

function summarizeSimulatedGate(records: ScenarioRecord[], spec: SimulatedGateSpec) {
  const completed = records.filter((record) => record.status === "completed");
  const comparable = completed.filter((record) => record.rawEvaluationDeltaVsBaseline !== null);
  const interventions = comparable.filter((record) => record.intervened && spec.pass(record));
  const deltas = comparable.map((record) =>
    record.intervened && spec.pass(record) ? (record.rawEvaluationDeltaVsBaseline ?? 0) : 0,
  );
  const positive = deltas.filter((value) => value > STRICT_EPSILON);
  const negative = deltas.filter((value) => value < -STRICT_EPSILON);
  const comparableWeight = sum(comparable.map((record) => record.weight));
  const interventionWeight = sum(interventions.map((record) => record.weight));
  const weightedDeltaSum = weightedSum(comparable, (record) =>
    record.intervened && spec.pass(record) ? (record.rawEvaluationDeltaVsBaseline ?? 0) : 0,
  );
  const weightedInterventionDeltaSum = weightedSum(
    interventions,
    (record) => record.rawEvaluationDeltaVsBaseline ?? 0,
  );
  return {
    key: spec.key,
    description: spec.description,
    comparableCount: comparable.length,
    interventionCount: interventions.length,
    interventionRate: comparable.length > 0 ? interventions.length / comparable.length : null,
    comparableWeight,
    interventionWeight,
    weightedInterventionRate: comparableWeight > 0 ? interventionWeight / comparableWeight : null,
    sumDelta: sum(deltas),
    meanDelta: mean(deltas),
    interventionSumDelta: sum(
      interventions
        .map((record) => record.rawEvaluationDeltaVsBaseline)
        .filter((value): value is number => value !== null),
    ),
    interventionMeanDelta: mean(
      interventions
        .map((record) => record.rawEvaluationDeltaVsBaseline)
        .filter((value): value is number => value !== null),
    ),
    weightedSumDelta: weightedDeltaSum,
    weightedMeanDelta: comparableWeight > 0 ? weightedDeltaSum / comparableWeight : null,
    weightedInterventionSumDelta: weightedInterventionDeltaSum,
    weightedInterventionMeanDelta:
      interventionWeight > 0 ? weightedInterventionDeltaSum / interventionWeight : null,
    positiveDeltaCount: positive.length,
    positiveDeltaSum: sum(positive),
    negativeDeltaCount: negative.length,
    negativeDeltaSum: sum(negative),
    falsePositiveCount: interventions.filter(
      (record) => (record.rawEvaluationDeltaVsBaseline ?? 0) > STRICT_EPSILON,
    ).length,
    falseNegativeCount: comparable.filter(
      (record) =>
        record.intervened &&
        !spec.pass(record) &&
        (record.rawEvaluationDeltaVsBaseline ?? 0) < -STRICT_EPSILON,
    ).length,
    worstPositiveDeltaTop: interventions
      .filter((record) => (record.rawEvaluationDeltaVsBaseline ?? 0) > STRICT_EPSILON)
      .sort((a, b) => (b.rawEvaluationDeltaVsBaseline ?? 0) - (a.rawEvaluationDeltaVsBaseline ?? 0))
      .slice(0, 5)
      .map((record) => ({
        scenarioId: record.scenarioId,
        delta: record.rawEvaluationDeltaVsBaseline,
      })),
    bestNegativeDeltaTop: interventions
      .filter((record) => (record.rawEvaluationDeltaVsBaseline ?? 0) < -STRICT_EPSILON)
      .sort((a, b) => (a.rawEvaluationDeltaVsBaseline ?? 0) - (b.rawEvaluationDeltaVsBaseline ?? 0))
      .slice(0, 5)
      .map((record) => ({
        scenarioId: record.scenarioId,
        delta: record.rawEvaluationDeltaVsBaseline,
      })),
  };
}

function pairedUpperBound(record: ScenarioRecord, z: number) {
  if (record.gatePairMeanDelta === null || record.gatePairStandardError === null) return null;
  return record.gatePairMeanDelta + z * record.gatePairStandardError;
}

function gateSweepSpecs(): SimulatedGateSpec[] {
  return [
    {
      key: "pairedMeanNegative",
      description: "Paired gate seed point estimate is below baseline.",
      pass: (record) => (record.gatePairMeanDelta ?? Number.POSITIVE_INFINITY) < 0,
    },
    {
      key: "paired80",
      description: "Paired upper bound with z=1.282 is below baseline.",
      pass: (record) => (pairedUpperBound(record, 1.282) ?? Number.POSITIVE_INFINITY) < 0,
    },
    {
      key: "paired90",
      description: "Paired upper bound with z=1.645 is below baseline.",
      pass: (record) => (pairedUpperBound(record, 1.645) ?? Number.POSITIVE_INFINITY) < 0,
    },
    {
      key: "paired90Margin025",
      description: "Paired upper bound with z=1.645 is below -0.00025.",
      pass: (record) => (pairedUpperBound(record, 1.645) ?? Number.POSITIVE_INFINITY) < -0.00025,
    },
    {
      key: "a2Negative",
      description: "A2 surrogate delta is below baseline.",
      pass: (record) => (record.a2DeltaVsBaseline ?? Number.POSITIVE_INFINITY) < 0,
    },
    {
      key: "a2Margin025",
      description: "A2 surrogate delta is below -0.00025.",
      pass: (record) => (record.a2DeltaVsBaseline ?? Number.POSITIVE_INFINITY) < -0.00025,
    },
    {
      key: "a2Margin05",
      description: "A2 surrogate delta is below -0.0005.",
      pass: (record) => (record.a2DeltaVsBaseline ?? Number.POSITIVE_INFINITY) < -0.0005,
    },
    {
      key: "a2NegativeAndPairedMean",
      description: "A2 surrogate is negative and paired gate seed point estimate is negative.",
      pass: (record) =>
        (record.a2DeltaVsBaseline ?? Number.POSITIVE_INFINITY) < 0 &&
        (record.gatePairMeanDelta ?? Number.POSITIVE_INFINITY) < 0,
    },
    {
      key: "a2NegativeAndPaired80",
      description: "A2 surrogate is negative and paired upper bound z=1.282 is below baseline.",
      pass: (record) =>
        (record.a2DeltaVsBaseline ?? Number.POSITIVE_INFINITY) < 0 &&
        (pairedUpperBound(record, 1.282) ?? Number.POSITIVE_INFINITY) < 0,
    },
    {
      key: "a2Margin025AndPairedMean",
      description: "A2 surrogate is below -0.00025 and paired point estimate is negative.",
      pass: (record) =>
        (record.a2DeltaVsBaseline ?? Number.POSITIVE_INFINITY) < -0.00025 &&
        (record.gatePairMeanDelta ?? Number.POSITIVE_INFINITY) < 0,
    },
  ];
}

function summarizeGateSweep(records: ScenarioRecord[]) {
  return Object.fromEntries(
    gateSweepSpecs().map((spec) => [spec.key, summarizeSimulatedGate(records, spec)]),
  );
}

function summarizePolicyDeltas(records: ScenarioRecord[]) {
  return {
    raw: summarizeDeltaRecords(records, "rawEvaluationDeltaVsBaseline", "intervened"),
    twoFold: summarizeDeltaRecords(
      records,
      "twoFoldEvaluationDeltaVsBaseline",
      "twoFoldIntervened",
      "twoFoldFalsePositive",
      "twoFoldFalseNegative",
    ),
    paired95: summarizeDeltaRecords(
      records,
      "paired95EvaluationDeltaVsBaseline",
      "paired95Intervened",
      "paired95FalsePositive",
      "paired95FalseNegative",
    ),
    adaptive90: summarizeDeltaRecords(
      records,
      "adaptive90EvaluationDeltaVsBaseline",
      "adaptive90Intervened",
      "adaptive90FalsePositive",
      "adaptive90FalseNegative",
    ),
    a2Gate: summarizeDeltaRecords(
      records,
      "a2GateEvaluationDeltaVsBaseline",
      "a2GateIntervened",
      "a2GateFalsePositive",
      "a2GateFalseNegative",
    ),
  };
}

function summarize(records: ScenarioRecord[]) {
  const completed = records.filter((record) => record.status === "completed");
  const intervened = completed.filter((record) => record.intervened);
  const heldOutComparable = completed.filter((record) => record.heldOutDeltaVsBaseline !== null);
  const heldOutNonWorse = heldOutComparable.filter((record) => record.heldOutNonWorse);
  const heldOutStrictImproved = heldOutComparable.filter((record) => record.heldOutStrictImproved);
  const heldOutInterventions = heldOutComparable.filter((record) => record.intervened);
  const heldOutInterventionStrictImproved = heldOutInterventions.filter(
    (record) => record.heldOutStrictImproved,
  );
  const completedWeight = sum(completed.map((record) => record.weight));

  return {
    scenarioCount: records.length,
    completedCount: completed.length,
    totalWeight: sum(records.map((record) => record.weight)),
    completedWeight,
    noActionCount: records.filter((record) => record.status === "no-action").length,
    errorCount: records.filter((record) => record.status === "error").length,
    interventionCount: intervened.length,
    interventionRate: completed.length > 0 ? intervened.length / completed.length : null,
    heldOutComparableCount: heldOutComparable.length,
    heldOutNonWorseCount: heldOutNonWorse.length,
    heldOutNonWorseRate:
      heldOutComparable.length > 0 ? heldOutNonWorse.length / heldOutComparable.length : null,
    heldOutStrictImprovedCount: heldOutStrictImproved.length,
    heldOutStrictImprovementRate:
      heldOutComparable.length > 0 ? heldOutStrictImproved.length / heldOutComparable.length : null,
    heldOutInterventionComparableCount: heldOutInterventions.length,
    heldOutInterventionStrictImprovedCount: heldOutInterventionStrictImproved.length,
    heldOutInterventionStrictImprovementRate:
      heldOutInterventions.length > 0
        ? heldOutInterventionStrictImproved.length / heldOutInterventions.length
        : null,
    meanSelectedProbabilityLossVsBaseline: mean(
      completed
        .map((record) => record.selectedProbabilityLossVsBaseline)
        .filter((value): value is number => value !== null),
    ),
    maxSelectedProbabilityLossVsBaseline: completed.reduce(
      (max, record) => Math.max(max, record.selectedProbabilityLossVsBaseline ?? 0),
      0,
    ),
    meanInSampleDeltaVsBaseline: mean(
      completed
        .map((record) => record.inSampleDeltaVsBaseline)
        .filter((value): value is number => value !== null),
    ),
    meanHeldOutDeltaVsBaseline: mean(
      heldOutComparable
        .map((record) => record.heldOutDeltaVsBaseline)
        .filter((value): value is number => value !== null),
    ),
    meanElapsedMs: mean(completed.map((record) => record.elapsedMs)),
    weightedMeanElapsedMs:
      completedWeight > 0
        ? weightedSum(completed, (record) => record.elapsedMs) / completedWeight
        : null,
    maxElapsedMs: completed.reduce((max, record) => Math.max(max, record.elapsedMs), 0),
  };
}

function summarizeBySource(records: ScenarioRecord[]) {
  const sources = [...new Set(records.map((record) => record.source))].sort();
  return Object.fromEntries(
    sources.map((source) => [
      source,
      summarize(records.filter((record) => record.source === source)),
    ]),
  );
}

function summarizeA2(records: ScenarioRecord[]) {
  const completed = records.filter((record) => record.status === "completed");
  const comparable = completed.filter((record) => record.a2DeltaVsBaseline !== null);
  const deltas = comparable
    .map((record) => record.a2DeltaVsBaseline)
    .filter((value): value is number => value !== null);
  return {
    comparableCount: comparable.length,
    errorCount: completed.filter((record) => record.a2ErrorMessage !== null).length,
    sumDelta: sum(deltas),
    meanDelta: mean(deltas),
    positiveDeltaCount: deltas.filter((value) => value > STRICT_EPSILON).length,
    negativeDeltaCount: deltas.filter((value) => value < -STRICT_EPSILON).length,
    maxNodeCount: completed.reduce((max, record) => Math.max(max, record.a2NodeCount ?? 0), 0),
  };
}

function summarizeA1(records: ScenarioRecord[]) {
  const completed = records.filter((record) => record.status === "completed");
  const comparable = completed.filter((record) => record.a1DeltaVsBaseline !== null);
  const deltas = comparable
    .map((record) => record.a1DeltaVsBaseline)
    .filter((value): value is number => value !== null);
  const nonZeroA1 = comparable.filter(
    (record) => Math.abs(record.a1DeltaVsBaseline ?? 0) > STRICT_EPSILON,
  );
  const sign = (value: number | null) => {
    if (value === null) return 0;
    if (value > STRICT_EPSILON) return 1;
    if (value < -STRICT_EPSILON) return -1;
    return 0;
  };
  const agreesWithA1 = (key: "rawEvaluationDeltaVsBaseline" | "a2DeltaVsBaseline") =>
    nonZeroA1.filter((record) => sign(record[key]) === sign(record.a1DeltaVsBaseline)).length;
  const paired95Interventions = comparable.filter((record) => record.paired95Intervened);
  return {
    comparableCount: comparable.length,
    errorCount: completed.filter((record) => record.a1ErrorMessage !== null).length,
    sumDelta: sum(deltas),
    meanDelta: mean(deltas),
    positiveDeltaCount: deltas.filter((value) => value > STRICT_EPSILON).length,
    negativeDeltaCount: deltas.filter((value) => value < -STRICT_EPSILON).length,
    maxNodeCount: completed.reduce((max, record) => Math.max(max, record.a1NodeCount ?? 0), 0),
    mcSignAgreementCount: agreesWithA1("rawEvaluationDeltaVsBaseline"),
    a2SignAgreementCount: agreesWithA1("a2DeltaVsBaseline"),
    signComparableCount: nonZeroA1.length,
    paired95InterventionCount: paired95Interventions.length,
    paired95PositiveA1Count: paired95Interventions.filter(
      (record) => (record.a1DeltaVsBaseline ?? 0) > STRICT_EPSILON,
    ).length,
  };
}

function finiteNumbers(values: Array<number | null>) {
  return values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

function summarizePairedDiagnostics(
  records: ScenarioRecord[],
  standardErrorKey: "gatePairStandardError" | "adaptive90GateStandardError",
  correlationKey: "gatePairCorrelation" | "adaptive90GateCorrelation",
  runsKey?: "adaptive90GateRuns",
) {
  const completed = records.filter((record) => record.status === "completed");
  const standardErrors = finiteNumbers(completed.map((record) => record[standardErrorKey]));
  const correlations = finiteNumbers(completed.map((record) => record[correlationKey]));
  const runs = runsKey
    ? finiteNumbers(completed.map((record) => record[runsKey])).filter((value) => value > 0)
    : [];
  return {
    comparableCount: completed.length,
    standardErrorCount: standardErrors.length,
    meanStandardError: mean(standardErrors),
    maxStandardError: standardErrors.length > 0 ? Math.max(...standardErrors) : null,
    correlationCount: correlations.length,
    meanCorrelation: mean(correlations),
    minCorrelation: correlations.length > 0 ? Math.min(...correlations) : null,
    maxCorrelation: correlations.length > 0 ? Math.max(...correlations) : null,
    meanGateRuns: runs.length > 0 ? mean(runs) : null,
    quickGateCount:
      runsKey === "adaptive90GateRuns"
        ? completed.filter((record) => record[runsKey] === ADAPTIVE_QUICK_RUNS).length
        : null,
    fullGateCount:
      runsKey === "adaptive90GateRuns"
        ? completed.filter((record) => record[runsKey] === ADAPTIVE_MAX_RUNS).length
        : null,
  };
}

const runs = parsePositiveInteger(process.env.RUST_RERANK_BENCH_RUNS, DEFAULT_RUNS);
const seed = parsePositiveInteger(process.env.RUST_RERANK_BENCH_SEED, DEFAULT_SEED);
const heldOutSeed = parsePositiveInteger(
  process.env.RUST_RERANK_BENCH_HELD_OUT_SEED,
  DEFAULT_HELD_OUT_SEED,
);
const evaluationSeeds = parseIntegerList(
  process.env.RUST_RERANK_BENCH_EVAL_SEEDS,
  DEFAULT_EVALUATION_SEEDS,
);
const a1SentinelIds = new Set(
  parseList(process.env.RUST_RERANK_BENCH_A1_SENTINELS, DEFAULT_A1_SENTINEL_IDS),
);
const weightSpec = parseRustBenchmarkWeightSpec(
  process.env.RUST_RERANK_BENCH_WEIGHTS,
  process.env.RUST_RERANK_BENCH_WEIGHT_PROFILE,
);
await mkdir(RESULTS_DIRECTORY, { recursive: true });

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

const rustCore = (await server.ssrLoadModule(
  "/src/wasm/rustCore.ts",
)) as typeof import("../src/wasm/rustCore");
const fixedGrid = (await server.ssrLoadModule(
  "/benchmarks/scenarios/fixed-grid.ts",
)) as typeof import("./scenarios/fixed-grid");
const supplemental = (await server.ssrLoadModule(
  "/benchmarks/scenarios/rerank-supplemental.ts",
)) as typeof import("./scenarios/rerank-supplemental");
const productObserved = (await server.ssrLoadModule(
  "/benchmarks/scenarios/rerank-product.ts",
)) as typeof import("./scenarios/rerank-product");

const requestedSources = parseSources(process.env.RUST_RERANK_BENCH_SOURCES);
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
  process.env.RUST_RERANK_BENCH_SCENARIOS,
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

function summarizeEvaluationPairs(pairs: RustPairedExpectedCostEstimate[]) {
  const runs = pairs.reduce((total, pair) => total + pair.runs, 0);
  const sumDelta = pairs.reduce((total, pair) => total + pair.meanDelta * pair.runs, 0);
  const sumDeltaSq = pairs.reduce((total, pair) => total + pair.deltaSumSq, 0);
  const meanDelta = runs > 0 ? sumDelta / runs : 0;
  const variance = runs > 0 ? Math.max(0, sumDeltaSq / runs - meanDelta * meanDelta) : 0;
  const standardError = runs > 0 ? Math.sqrt(variance / runs) : 0;
  const seedMeans = pairs.map((pair) => pair.meanDelta);
  return {
    runs,
    meanDelta,
    standardError,
    upper95: meanDelta + 1.96 * standardError,
    seedSpread: seedMeans.length > 0 ? Math.max(...seedMeans) - Math.min(...seedMeans) : null,
  };
}

type Adaptive90Decision = {
  rawSelectedFirstAction: string | null;
  selectedFirstAction: string | null;
  gatePass: boolean | null;
  intervened: boolean;
  evaluationDeltaVsBaseline: number | null;
  falsePositive: boolean | null;
  falseNegative: boolean | null;
  gateRuns: number | null;
  gateMeanDelta: number | null;
  gateStandardError: number | null;
  gateUpperBound: number | null;
  gateCorrelation: number | null;
};

function nullAdaptive90Decision(): Adaptive90Decision {
  return {
    rawSelectedFirstAction: null,
    selectedFirstAction: null,
    gatePass: null,
    intervened: false,
    evaluationDeltaVsBaseline: null,
    falsePositive: null,
    falseNegative: null,
    gateRuns: null,
    gateMeanDelta: null,
    gateStandardError: null,
    gateUpperBound: null,
    gateCorrelation: null,
  };
}

function calculateAdaptiveGateUpperBound(pair: RustPairedExpectedCostEstimate) {
  return pair.meanDelta + ADAPTIVE_GATE_Z * pair.standardError;
}

try {
  const wasm = await readFile(WASM_URL);
  const instantiated = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  const instance =
    instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
  const solver = rustCore.createRustPhase2Solver(instance.exports as unknown as RustCoreExports);

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
        records.push({
          ...common,
          status: "no-action",
          candidateCount: rerank?.candidates.length ?? 0,
          baselineFirstAction: rerank?.baseline.firstAction ?? null,
          selectedFirstAction: rerank?.selected.firstAction ?? null,
          intervened: false,
          baselineSuccessProbability: rerank?.baseline.successProbability ?? null,
          selectedSuccessProbability: rerank?.selected.successProbability ?? null,
          selectedProbabilityGap: rerank?.selected.probabilityGap ?? null,
          selectedProbabilityLossVsBaseline: null,
          inSampleBaselineExpectedCost: null,
          inSampleSelectedExpectedCost: rerank?.selected.expectedCost ?? null,
          inSampleDeltaVsBaseline: null,
          inSampleCompletionRate: rerank?.selected.completionRate ?? null,
          heldOutBaselineExpectedCost: null,
          heldOutSelectedExpectedCost: null,
          heldOutDeltaVsBaseline: null,
          heldOutBaselineCompletionRate: null,
          heldOutSelectedCompletionRate: null,
          heldOutNonWorse: null,
          heldOutStrictImproved: null,
          rawEvaluationDeltaVsBaseline: null,
          rawEvaluationStandardError: null,
          rawEvaluationUpper95: null,
          rawEvaluationSeedSpread: null,
          twoFoldGatePass: null,
          twoFoldIntervened: false,
          twoFoldEvaluationDeltaVsBaseline: null,
          twoFoldFalsePositive: null,
          twoFoldFalseNegative: null,
          paired95GatePass: null,
          paired95Intervened: false,
          paired95EvaluationDeltaVsBaseline: null,
          paired95FalsePositive: null,
          paired95FalseNegative: null,
          adaptive90RawSelectedFirstAction: null,
          adaptive90SelectedFirstAction: null,
          adaptive90GatePass: null,
          adaptive90Intervened: false,
          adaptive90EvaluationDeltaVsBaseline: null,
          adaptive90FalsePositive: null,
          adaptive90FalseNegative: null,
          adaptive90GateRuns: null,
          adaptive90GateMeanDelta: null,
          adaptive90GateStandardError: null,
          adaptive90GateUpperBound: null,
          adaptive90GateCorrelation: null,
          a2GatePass: null,
          a2GateIntervened: false,
          a2GateEvaluationDeltaVsBaseline: null,
          a2GateFalsePositive: null,
          a2GateFalseNegative: null,
          gatePairMeanDelta: null,
          gatePairStandardError: null,
          gatePairUpper95: null,
          gatePairCorrelation: null,
          a2BaselineSurrogateCost: null,
          a2SelectedSurrogateCost: null,
          a2DeltaVsBaseline: null,
          a2NodeCount: null,
          a2ErrorMessage: null,
          a1BaselineExactCost: null,
          a1SelectedExactCost: null,
          a1DeltaVsBaseline: null,
          a1NodeCount: null,
          a1ErrorMessage: null,
          elapsedMs: Math.round(performance.now() - scenarioStartedAt),
        });
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
      let adaptive90 = nullAdaptive90Decision();
      const adaptiveRerank = solver.selectFirstActionByExpectedCost(
        scenario.start,
        scenario.stock,
        ADAPTIVE_QUICK_RUNS,
        seed,
        HORIZON_FACTOR,
        NORM_POWER,
        TOLERANCE,
      );
      const adaptiveBaselineAction = adaptiveRerank?.baseline.firstAction;
      const adaptiveRawSelectedAction = adaptiveRerank?.selected.firstAction;
      if (adaptiveBaselineAction && adaptiveRawSelectedAction) {
        if (adaptiveBaselineAction === adaptiveRawSelectedAction) {
          adaptive90 = {
            rawSelectedFirstAction: adaptiveRawSelectedAction,
            selectedFirstAction: adaptiveBaselineAction,
            gatePass: true,
            intervened: false,
            evaluationDeltaVsBaseline: 0,
            falsePositive: false,
            falseNegative: false,
            gateRuns: 0,
            gateMeanDelta: null,
            gateStandardError: null,
            gateUpperBound: null,
            gateCorrelation: null,
          };
        } else {
          const adaptiveQuickPair = solver.estimateExpectedCostPairFromCurrent(
            scenario.start,
            scenario.stock,
            adaptiveBaselineAction,
            adaptiveRawSelectedAction,
            ADAPTIVE_QUICK_RUNS,
            heldOutSeed,
            HORIZON_FACTOR,
            NORM_POWER,
          );
          let adaptiveGatePair = adaptiveQuickPair;
          let adaptiveGateRuns = ADAPTIVE_QUICK_RUNS;
          let adaptiveGateUpperBound = calculateAdaptiveGateUpperBound(adaptiveQuickPair);
          let adaptiveGatePass = adaptiveGateUpperBound < ADAPTIVE_QUICK_ACCEPT_MARGIN;
          const adaptiveQuickLowerBound =
            adaptiveQuickPair.meanDelta - ADAPTIVE_GATE_Z * adaptiveQuickPair.standardError;
          if (!adaptiveGatePass && adaptiveQuickLowerBound < 0) {
            adaptiveGatePair = solver.estimateExpectedCostPairFromCurrent(
              scenario.start,
              scenario.stock,
              adaptiveBaselineAction,
              adaptiveRawSelectedAction,
              ADAPTIVE_MAX_RUNS,
              heldOutSeed,
              HORIZON_FACTOR,
              NORM_POWER,
            );
            adaptiveGateRuns = ADAPTIVE_MAX_RUNS;
            adaptiveGateUpperBound = calculateAdaptiveGateUpperBound(adaptiveGatePair);
            adaptiveGatePass = adaptiveGateUpperBound < ADAPTIVE_FULL_ACCEPT_MARGIN;
          }
          const adaptiveEvaluationPairs = evaluationSeeds.map((evaluationSeed) =>
            solver.estimateExpectedCostPairFromCurrent(
              scenario.start,
              scenario.stock,
              adaptiveBaselineAction,
              adaptiveRawSelectedAction,
              ADAPTIVE_MAX_RUNS,
              evaluationSeed,
              HORIZON_FACTOR,
              NORM_POWER,
            ),
          );
          const adaptiveEvaluation = summarizeEvaluationPairs(adaptiveEvaluationPairs);
          const adaptiveEvaluationSelectedImproves = adaptiveEvaluation.meanDelta < -STRICT_EPSILON;
          const adaptiveEvaluationSelectedWorsens = adaptiveEvaluation.meanDelta > STRICT_EPSILON;
          adaptive90 = {
            rawSelectedFirstAction: adaptiveRawSelectedAction,
            selectedFirstAction: adaptiveGatePass
              ? adaptiveRawSelectedAction
              : adaptiveBaselineAction,
            gatePass: adaptiveGatePass,
            intervened: adaptiveGatePass,
            evaluationDeltaVsBaseline: adaptiveGatePass ? adaptiveEvaluation.meanDelta : 0,
            falsePositive: adaptiveGatePass ? adaptiveEvaluationSelectedWorsens : false,
            falseNegative: !adaptiveGatePass ? adaptiveEvaluationSelectedImproves : false,
            gateRuns: adaptiveGateRuns,
            gateMeanDelta: adaptiveGatePair.meanDelta,
            gateStandardError: adaptiveGatePair.standardError,
            gateUpperBound: adaptiveGateUpperBound,
            gateCorrelation: adaptiveGatePair.correlation,
          };
        }
      }
      let a2BaselineSurrogateCost: number | null = null;
      let a2SelectedSurrogateCost: number | null = null;
      let a2DeltaVsBaseline: number | null = null;
      let a2NodeCount: number | null = null;
      let a2ErrorMessage: string | null = null;
      let a1BaselineExactCost: number | null = null;
      let a1SelectedExactCost: number | null = null;
      let a1DeltaVsBaseline: number | null = null;
      let a1NodeCount: number | null = null;
      let a1ErrorMessage: string | null = null;
      try {
        const a2Selected = solver.estimateA2SurrogateAfterFirstActionFromCurrent(
          scenario.start,
          scenario.stock,
          selectedFirstAction,
          HORIZON_FACTOR,
          NORM_POWER,
        );
        const a2Baseline =
          baselineFirstAction === selectedFirstAction
            ? a2Selected
            : solver.estimateA2SurrogateAfterFirstActionFromCurrent(
                scenario.start,
                scenario.stock,
                baselineFirstAction,
                HORIZON_FACTOR,
                NORM_POWER,
              );
        a2BaselineSurrogateCost = a2Baseline.surrogateCost;
        a2SelectedSurrogateCost = a2Selected.surrogateCost;
        a2DeltaVsBaseline = a2Selected.surrogateCost - a2Baseline.surrogateCost;
        a2NodeCount = Math.max(a2Baseline.nodeCount, a2Selected.nodeCount);
      } catch (error) {
        a2ErrorMessage = error instanceof Error ? error.message : String(error);
      }
      if (a1SentinelIds.has(scenario.id)) {
        try {
          const a1Selected = solver.estimateExactExpectedCostAfterFirstActionFromCurrent(
            scenario.start,
            scenario.stock,
            selectedFirstAction,
            HORIZON_FACTOR,
            NORM_POWER,
          );
          const a1Baseline =
            baselineFirstAction === selectedFirstAction
              ? a1Selected
              : solver.estimateExactExpectedCostAfterFirstActionFromCurrent(
                  scenario.start,
                  scenario.stock,
                  baselineFirstAction,
                  HORIZON_FACTOR,
                  NORM_POWER,
                );
          a1BaselineExactCost = a1Baseline.expectedCost;
          a1SelectedExactCost = a1Selected.expectedCost;
          a1DeltaVsBaseline = a1Selected.expectedCost - a1Baseline.expectedCost;
          a1NodeCount = Math.max(a1Baseline.nodeCount, a1Selected.nodeCount);
        } catch (error) {
          a1ErrorMessage = error instanceof Error ? error.message : String(error);
        }
      }
      const a2GatePass = a2DeltaVsBaseline === null ? null : a2DeltaVsBaseline < -STRICT_EPSILON;
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
        a2BaselineSurrogateCost,
        a2SelectedSurrogateCost,
        a2DeltaVsBaseline,
        a2NodeCount,
        a2ErrorMessage,
        a1BaselineExactCost,
        a1SelectedExactCost,
        a1DeltaVsBaseline,
        a1NodeCount,
        a1ErrorMessage,
        elapsedMs: Math.round(performance.now() - scenarioStartedAt),
      });
    } catch (error) {
      records.push({
        ...common,
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        candidateCount: 0,
        baselineFirstAction: null,
        selectedFirstAction: null,
        intervened: false,
        baselineSuccessProbability: null,
        selectedSuccessProbability: null,
        selectedProbabilityGap: null,
        selectedProbabilityLossVsBaseline: null,
        inSampleBaselineExpectedCost: null,
        inSampleSelectedExpectedCost: null,
        inSampleDeltaVsBaseline: null,
        inSampleCompletionRate: null,
        heldOutBaselineExpectedCost: null,
        heldOutSelectedExpectedCost: null,
        heldOutDeltaVsBaseline: null,
        heldOutBaselineCompletionRate: null,
        heldOutSelectedCompletionRate: null,
        heldOutNonWorse: null,
        heldOutStrictImproved: null,
        rawEvaluationDeltaVsBaseline: null,
        rawEvaluationStandardError: null,
        rawEvaluationUpper95: null,
        rawEvaluationSeedSpread: null,
        twoFoldGatePass: null,
        twoFoldIntervened: false,
        twoFoldEvaluationDeltaVsBaseline: null,
        twoFoldFalsePositive: null,
        twoFoldFalseNegative: null,
        paired95GatePass: null,
        paired95Intervened: false,
        paired95EvaluationDeltaVsBaseline: null,
        paired95FalsePositive: null,
        paired95FalseNegative: null,
        adaptive90RawSelectedFirstAction: null,
        adaptive90SelectedFirstAction: null,
        adaptive90GatePass: null,
        adaptive90Intervened: false,
        adaptive90EvaluationDeltaVsBaseline: null,
        adaptive90FalsePositive: null,
        adaptive90FalseNegative: null,
        adaptive90GateRuns: null,
        adaptive90GateMeanDelta: null,
        adaptive90GateStandardError: null,
        adaptive90GateUpperBound: null,
        adaptive90GateCorrelation: null,
        a2GatePass: null,
        a2GateIntervened: false,
        a2GateEvaluationDeltaVsBaseline: null,
        a2GateFalsePositive: null,
        a2GateFalseNegative: null,
        gatePairMeanDelta: null,
        gatePairStandardError: null,
        gatePairUpper95: null,
        gatePairCorrelation: null,
        a2BaselineSurrogateCost: null,
        a2SelectedSurrogateCost: null,
        a2DeltaVsBaseline: null,
        a2NodeCount: null,
        a2ErrorMessage: null,
        a1BaselineExactCost: null,
        a1SelectedExactCost: null,
        a1DeltaVsBaseline: null,
        a1NodeCount: null,
        a1ErrorMessage: null,
        elapsedMs: Math.round(performance.now() - scenarioStartedAt),
      });
    }
  }

  const report = {
    kind: "rust-rerank-benchmark",
    version: 1,
    generatedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - startedAt),
    options: {
      runs,
      seed,
      heldOutSeed,
      evaluationSeeds,
      a1SentinelIds: [...a1SentinelIds],
      weightSpec: serializeRustBenchmarkWeightSpec(weightSpec),
      horizonFactor: HORIZON_FACTOR,
      normPower: NORM_POWER,
      tolerance: TOLERANCE,
      adaptive90: {
        quickRuns: ADAPTIVE_QUICK_RUNS,
        maxRuns: ADAPTIVE_MAX_RUNS,
        gateZ: ADAPTIVE_GATE_Z,
        quickAcceptMargin: ADAPTIVE_QUICK_ACCEPT_MARGIN,
        fullAcceptMargin: ADAPTIVE_FULL_ACCEPT_MARGIN,
      },
      sources: [...requestedSources],
      scenarioIds,
    },
    summary: summarize(records),
    policySummaries: summarizePolicyDeltas(records),
    policySummariesBySource: Object.fromEntries(
      [...new Set(records.map((record) => record.source))]
        .sort()
        .map((source) => [
          source,
          summarizePolicyDeltas(records.filter((record) => record.source === source)),
        ]),
    ),
    gateSweep: summarizeGateSweep(records),
    gateSweepBySource: Object.fromEntries(
      [...new Set(records.map((record) => record.source))]
        .sort()
        .map((source) => [
          source,
          summarizeGateSweep(records.filter((record) => record.source === source)),
        ]),
    ),
    pairedMcDiagnostics: {
      paired95Gate: summarizePairedDiagnostics(
        records,
        "gatePairStandardError",
        "gatePairCorrelation",
      ),
      adaptive90Gate: summarizePairedDiagnostics(
        records,
        "adaptive90GateStandardError",
        "adaptive90GateCorrelation",
        "adaptive90GateRuns",
      ),
    },
    a2Summary: summarizeA2(records),
    a1Summary: summarizeA1(records),
    bySource: summarizeBySource(records),
    records,
  };

  await writeFile(JSON_OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const columns = [
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
  const csv = [
    columns.join(","),
    ...records.map((record) => columns.map((column) => csvEscape(record[column])).join(",")),
  ].join("\n");
  await writeFile(CSV_OUTPUT_FILE, `${csv}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        kind: report.kind,
        elapsedMs: report.elapsedMs,
        summary: report.summary,
        policySummaries: report.policySummaries,
        gateSweep: report.gateSweep,
        pairedMcDiagnostics: report.pairedMcDiagnostics,
        a2Summary: report.a2Summary,
        a1Summary: report.a1Summary,
        bySource: report.bySource,
        json: JSON_OUTPUT_FILE.pathname,
        csv: CSV_OUTPUT_FILE.pathname,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
