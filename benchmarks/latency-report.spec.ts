import { describe, expect, it } from "vitest";

import {
  assertLatencyRecordConsistency,
  assertPhaseLatencyRecordConsistency,
  createLatencyMeasurementProtocol,
  nearestRankPercentile,
  summarizeLatencySamples,
  summarizePhaseLatencySamples,
} from "./latency-report";

describe("latency report contract", () => {
  it("preserves ordered samples and derives cold, p50, and p95", () => {
    const protocol = createLatencyMeasurementProtocol(5);
    const record = summarizeLatencySamples([10, 4, 2, 8, 6], protocol);

    expect(record).toEqual({
      outcome: "completed",
      samplesMs: [10, 4, 2, 8, 6],
      coldMs: 10,
      warmP50Ms: 4,
      warmP95Ms: 8,
      repeats: 5,
    });
    expect(() => assertLatencyRecordConsistency(record, protocol)).not.toThrow();
  });

  it("uses the nearest-rank ceil estimator", () => {
    expect(nearestRankPercentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(nearestRankPercentile([1, 2, 3, 4], 0.95)).toBe(4);
  });

  it("rejects inconsistent derived fields", () => {
    const protocol = createLatencyMeasurementProtocol(3);
    const record = summarizeLatencySamples([3, 1, 2], protocol);
    expect(() => assertLatencyRecordConsistency({ ...record, warmP95Ms: 1 }, protocol)).toThrow(
      "derived fields",
    );
  });

  it("derives and validates an independently sampled latency phase", () => {
    const record = summarizePhaseLatencySamples([5, 1, 3]);
    expect(record).toEqual({ samplesMs: [5, 1, 3], p50Ms: 3, p95Ms: 5, repeats: 3 });
    expect(() => assertPhaseLatencyRecordConsistency(record)).not.toThrow();
    expect(() => assertPhaseLatencyRecordConsistency({ ...record, repeats: 2 })).toThrow(
      "ordered samples",
    );
  });
});
