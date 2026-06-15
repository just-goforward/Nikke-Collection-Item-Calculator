import { mean, sum, weightedSum } from "./rust-rerank-summary-math.ts";
import { RUST_RERANK_STRICT_EPSILON, type ScenarioRecord } from "./rust-rerank-summary-model.ts";

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
  const positive = deltas.filter((value) => value > RUST_RERANK_STRICT_EPSILON);
  const negative = deltas.filter((value) => value < -RUST_RERANK_STRICT_EPSILON);
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
      .filter((record) => (record[deltaKey] ?? 0) > RUST_RERANK_STRICT_EPSILON)
      .sort((a, b) => (b[deltaKey] ?? 0) - (a[deltaKey] ?? 0))
      .slice(0, 5)
      .map((record) => ({ scenarioId: record.scenarioId, delta: record[deltaKey] })),
    bestNegativeDeltaTop: comparable
      .filter((record) => (record[deltaKey] ?? 0) < -RUST_RERANK_STRICT_EPSILON)
      .sort((a, b) => (a[deltaKey] ?? 0) - (b[deltaKey] ?? 0))
      .slice(0, 5)
      .map((record) => ({ scenarioId: record.scenarioId, delta: record[deltaKey] })),
  };
}

export function summarizePolicyDeltas(records: ScenarioRecord[]) {
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

export function summarize(records: ScenarioRecord[]) {
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

export function summarizeBySource(records: ScenarioRecord[]) {
  const sources = [...new Set(records.map((record) => record.source))].sort();
  return Object.fromEntries(
    sources.map((source) => [
      source,
      summarize(records.filter((record) => record.source === source)),
    ]),
  );
}

export function summarizeA2(records: ScenarioRecord[]) {
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
    positiveDeltaCount: deltas.filter((value) => value > RUST_RERANK_STRICT_EPSILON).length,
    negativeDeltaCount: deltas.filter((value) => value < -RUST_RERANK_STRICT_EPSILON).length,
    maxNodeCount: completed.reduce((max, record) => Math.max(max, record.a2NodeCount ?? 0), 0),
  };
}

export function summarizeA1(records: ScenarioRecord[]) {
  const completed = records.filter((record) => record.status === "completed");
  const comparable = completed.filter((record) => record.a1DeltaVsBaseline !== null);
  const deltas = comparable
    .map((record) => record.a1DeltaVsBaseline)
    .filter((value): value is number => value !== null);
  const nonZeroA1 = comparable.filter(
    (record) => Math.abs(record.a1DeltaVsBaseline ?? 0) > RUST_RERANK_STRICT_EPSILON,
  );
  const sign = (value: number | null) => {
    if (value === null) return 0;
    if (value > RUST_RERANK_STRICT_EPSILON) return 1;
    if (value < -RUST_RERANK_STRICT_EPSILON) return -1;
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
    positiveDeltaCount: deltas.filter((value) => value > RUST_RERANK_STRICT_EPSILON).length,
    negativeDeltaCount: deltas.filter((value) => value < -RUST_RERANK_STRICT_EPSILON).length,
    maxNodeCount: completed.reduce((max, record) => Math.max(max, record.a1NodeCount ?? 0), 0),
    mcSignAgreementCount: agreesWithA1("rawEvaluationDeltaVsBaseline"),
    a2SignAgreementCount: agreesWithA1("a2DeltaVsBaseline"),
    signComparableCount: nonZeroA1.length,
    paired95InterventionCount: paired95Interventions.length,
    paired95PositiveA1Count: paired95Interventions.filter(
      (record) => (record.a1DeltaVsBaseline ?? 0) > RUST_RERANK_STRICT_EPSILON,
    ).length,
  };
}

function finiteNumbers(values: Array<number | null>) {
  return values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

export function summarizePairedDiagnostics(
  records: ScenarioRecord[],
  standardErrorKey: "gatePairStandardError" | "adaptive90GateStandardError",
  correlationKey: "gatePairCorrelation" | "adaptive90GateCorrelation",
  runsKey?: "adaptive90GateRuns",
  adaptiveRuns?: { quickRuns: number; maxRuns: number },
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
      runsKey === "adaptive90GateRuns" && adaptiveRuns
        ? completed.filter((record) => record[runsKey] === adaptiveRuns.quickRuns).length
        : null,
    fullGateCount:
      runsKey === "adaptive90GateRuns" && adaptiveRuns
        ? completed.filter((record) => record[runsKey] === adaptiveRuns.maxRuns).length
        : null,
  };
}
