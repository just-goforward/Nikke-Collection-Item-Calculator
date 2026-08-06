export const LATENCY_PERCENTILE_ESTIMATOR = "nearest_rank_ceil" as const;

export type LatencyMeasurementProtocol = {
  repeats: number;
  discardColdSamples: number;
  quantiles: {
    warmP50: 0.5;
    warmP95: 0.95;
  };
  percentileEstimator: typeof LATENCY_PERCENTILE_ESTIMATOR;
};

export type CompletedLatencyRecord = {
  outcome: "completed";
  samplesMs: number[];
  coldMs: number;
  warmP50Ms: number;
  warmP95Ms: number;
  repeats: number;
};

export type CompletedPhaseLatencyRecord = {
  samplesMs: number[];
  p50Ms: number;
  p95Ms: number;
  repeats: number;
};

export function createLatencyMeasurementProtocol(repeats: number): LatencyMeasurementProtocol {
  if (!Number.isInteger(repeats) || repeats < 2) {
    throw new Error("Latency measurement requires at least two ordered samples.");
  }
  return {
    repeats,
    discardColdSamples: 1,
    quantiles: { warmP50: 0.5, warmP95: 0.95 },
    percentileEstimator: LATENCY_PERCENTILE_ESTIMATOR,
  };
}

export function nearestRankPercentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) {
    throw new Error("A percentile requires at least one sample.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  const value = sorted[index];
  if (value === undefined) throw new Error("Percentile index is outside the sample set.");
  return value;
}

export function summarizeLatencySamples(
  samplesMs: readonly number[],
  protocol: LatencyMeasurementProtocol,
): CompletedLatencyRecord {
  if (samplesMs.length !== protocol.repeats) {
    throw new Error(`Expected ${protocol.repeats} latency samples, received ${samplesMs.length}.`);
  }
  if (samplesMs.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error("Latency samples must be finite, non-negative numbers.");
  }
  const coldMs = samplesMs[0];
  if (coldMs === undefined) throw new Error("Missing cold latency sample.");
  const warm = samplesMs.slice(protocol.discardColdSamples);
  return {
    outcome: "completed",
    samplesMs: [...samplesMs],
    coldMs,
    warmP50Ms: nearestRankPercentile(warm, protocol.quantiles.warmP50),
    warmP95Ms: nearestRankPercentile(warm, protocol.quantiles.warmP95),
    repeats: samplesMs.length,
  };
}

export function assertLatencyRecordConsistency(
  record: CompletedLatencyRecord,
  protocol: LatencyMeasurementProtocol,
): void {
  const expected = summarizeLatencySamples(record.samplesMs, protocol);
  if (
    record.repeats !== expected.repeats ||
    record.coldMs !== expected.coldMs ||
    record.warmP50Ms !== expected.warmP50Ms ||
    record.warmP95Ms !== expected.warmP95Ms
  ) {
    throw new Error("Latency record derived fields do not match its ordered samples.");
  }
}

export function summarizePhaseLatencySamples(
  samplesMs: readonly number[],
): CompletedPhaseLatencyRecord {
  assertValidSamples(samplesMs);
  return {
    samplesMs: [...samplesMs],
    p50Ms: nearestRankPercentile(samplesMs, 0.5),
    p95Ms: nearestRankPercentile(samplesMs, 0.95),
    repeats: samplesMs.length,
  };
}

export function assertPhaseLatencyRecordConsistency(record: CompletedPhaseLatencyRecord): void {
  const expected = summarizePhaseLatencySamples(record.samplesMs);
  if (
    record.repeats !== expected.repeats ||
    record.p50Ms !== expected.p50Ms ||
    record.p95Ms !== expected.p95Ms
  ) {
    throw new Error("Phase latency derived fields do not match its ordered samples.");
  }
}

function assertValidSamples(samplesMs: readonly number[]): void {
  if (samplesMs.length === 0) throw new Error("Latency measurement has no samples.");
  if (samplesMs.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error("Latency samples must be finite, non-negative numbers.");
  }
}
