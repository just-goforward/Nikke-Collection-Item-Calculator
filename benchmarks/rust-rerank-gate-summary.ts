import { mean, sum, weightedSum } from "./rust-rerank-summary-math.ts";
import { RUST_RERANK_STRICT_EPSILON, type ScenarioRecord } from "./rust-rerank-summary-model.ts";

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
  const positive = deltas.filter((value) => value > RUST_RERANK_STRICT_EPSILON);
  const negative = deltas.filter((value) => value < -RUST_RERANK_STRICT_EPSILON);
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
      (record) => (record.rawEvaluationDeltaVsBaseline ?? 0) > RUST_RERANK_STRICT_EPSILON,
    ).length,
    falseNegativeCount: comparable.filter(
      (record) =>
        record.intervened &&
        !spec.pass(record) &&
        (record.rawEvaluationDeltaVsBaseline ?? 0) < -RUST_RERANK_STRICT_EPSILON,
    ).length,
    worstPositiveDeltaTop: interventions
      .filter((record) => (record.rawEvaluationDeltaVsBaseline ?? 0) > RUST_RERANK_STRICT_EPSILON)
      .sort((a, b) => (b.rawEvaluationDeltaVsBaseline ?? 0) - (a.rawEvaluationDeltaVsBaseline ?? 0))
      .slice(0, 5)
      .map((record) => ({
        scenarioId: record.scenarioId,
        delta: record.rawEvaluationDeltaVsBaseline,
      })),
    bestNegativeDeltaTop: interventions
      .filter((record) => (record.rawEvaluationDeltaVsBaseline ?? 0) < -RUST_RERANK_STRICT_EPSILON)
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

export function summarizeGateSweep(records: ScenarioRecord[]) {
  return Object.fromEntries(
    gateSweepSpecs().map((spec) => [spec.key, summarizeSimulatedGate(records, spec)]),
  );
}
