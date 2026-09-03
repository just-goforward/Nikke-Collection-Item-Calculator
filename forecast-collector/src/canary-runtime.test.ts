import { describe, expect, it } from "vitest";
import {
  type CpuPerformanceBaseline,
  evaluateForecastRuntimeTelemetry,
  FORECAST_RUNTIME_TELEMETRY_SOURCE,
  FORECAST_RUNTIME_WORKERS,
  type ForecastRuntimeSample,
  type ForecastRuntimeTelemetryEvidence,
} from "../../shared/forecastCanaryRuntime";

const SHA = "a".repeat(40);
const CANARY_ID = `fc-${"b".repeat(32)}`;
const COLLECTOR_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const DISPATCHER_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const START = Date.parse("2026-09-03T01:22:44.843Z");
const END = START + 8 * 60 * 60 * 1_000;

describe("forecast canary v10 runtime policy", () => {
  it("classifies the v8 CPU shape as a baseline warning instead of a failure", () => {
    const input = fixture();
    runtimeWorker(input, "collector").samples = samplesWithDistribution(
      slots(0),
      24.619,
      35.344,
      41.169,
    );
    runtimeWorker(input, "dispatcher").samples = samplesWithDistribution(
      slots(1),
      7.283,
      9.266,
      20.464,
      DISPATCHER_VERSION_ID,
    );

    const result = evaluateForecastRuntimeTelemetry(input);

    expect(result.evidence).toEqual({ status: "valid", errors: [] });
    expect(result.runtimeSafety).toEqual({ status: "passed", failureCodes: [] });
    expect(result.performance.status).toBe("baseline_bootstrap");
    expect(result.performance.warnings).toContain("runtime_p99_headroom_low:collector");
    expect(result.performance.warnings).toContain("runtime_p99_headroom_low:dispatcher");
    expect(result.performance.regressionCodes).toEqual([]);
    expect(result.performance.collector.full).toMatchObject({ p95Ms: 35.344, p99Ms: 41.169 });
    expect(result.performance.collector.full.averageMs).toBeCloseTo(24.619, 12);
    expect(result.performance.dispatcher.full).toMatchObject({ p95Ms: 9.266, p99Ms: 20.464 });
    expect(result.performance.dispatcher.full.averageMs).toBeCloseTo(7.283, 12);
  });

  it("keeps 80 and 95 percent p99 headroom thresholds as warnings", () => {
    const input = fixture();
    runtimeWorker(input, "collector").samples = samples(slots(0), 30, 40);
    runtimeWorker(input, "dispatcher").samples = samples(
      slots(1),
      10,
      23.75,
      DISPATCHER_VERSION_ID,
    );

    const result = evaluateForecastRuntimeTelemetry(input);

    expect(result.runtimeSafety.status).toBe("passed");
    expect(result.performance.warnings).toContain("runtime_p99_headroom_low:collector");
    expect(result.performance.warnings).not.toContain("runtime_p99_headroom_critical:collector");
    expect(result.performance.warnings).toContain("runtime_p99_headroom_critical:dispatcher");
  });

  it("warns without failing when a successful invocation reports CPU above the configured limit", () => {
    const input = fixture();
    const sample = runtimeWorker(input, "collector").samples.at(-1);
    if (!sample) throw new Error("missing_collector_sample");
    sample.cpuTimeMs = 51;

    const result = evaluateForecastRuntimeTelemetry(input);

    expect(result.runtimeSafety.status).toBe("passed");
    expect(result.performance.warnings).toContain(
      "runtime_success_above_configured_limit:collector",
    );
  });

  it("hard-fails an actual CPU termination", () => {
    const input = fixture();
    const sample = runtimeWorker(input, "collector").samples[0];
    if (!sample) throw new Error("missing_collector_sample");
    sample.outcome = "exceededCpu";

    const result = evaluateForecastRuntimeTelemetry(input);

    expect(result.runtimeSafety.status).toBe("failed");
    expect(result.runtimeSafety.failureCodes).toContain("runtime_exceeded_cpu:collector");
    expect(result.runtimeSafety.failureCodes).toContain("runtime_unsuccessful_outcome:collector");
  });

  it("marks delayed telemetry as incomplete without manufacturing a failure", () => {
    const input = fixture();
    runtimeWorker(input, "collector").samples.splice(0, 2);

    const result = evaluateForecastRuntimeTelemetry(input);

    expect(result.evidence.status).toBe("incomplete");
    expect(result.evidence.errors).toContain("runtime_telemetry_coverage_incomplete:collector");
    expect(result.runtimeSafety).toEqual({ status: "incomplete", failureCodes: [] });
  });

  it("accepts one missing telemetry slot at the 99 percent coverage boundary", () => {
    const input = fixture();
    runtimeWorker(input, "collector").samples.splice(0, 1);

    const result = evaluateForecastRuntimeTelemetry(input);

    expect(result.evidence).toEqual({ status: "valid", errors: [] });
    expect(result.runtimeSafety.status).toBe("passed");
  });

  it("accepts omitted optional version metadata with an explicit marker warning", () => {
    const input = fixture();
    for (const worker of input.telemetry.workers) {
      worker.samples = worker.samples.map((sample) => ({
        ...sample,
        scriptVersionId: null,
        scriptVersionTag: null,
        identitySource: "marker" as const,
      }));
    }

    const result = evaluateForecastRuntimeTelemetry(input);

    expect(result.evidence).toEqual({ status: "valid", errors: [] });
    expect(result.runtimeSafety.status).toBe("passed");
    expect(result.performance.warnings).toContain("runtime_version_metadata_unavailable:collector");
    expect(result.performance.warnings).toContain(
      "runtime_version_metadata_unavailable:dispatcher",
    );
  });
});

describe("forecast canary v10 runtime evidence and regression policy", () => {
  it("keeps a final Observability API failure as incomplete evidence", () => {
    const input = fixture();
    input.telemetry.collectionErrors = ["observability_http_403"];
    input.telemetry.workers.forEach((worker) => {
      worker.samples = [];
    });

    const result = evaluateForecastRuntimeTelemetry(input);

    expect(result.evidence.status).toBe("incomplete");
    expect(result.evidence.errors).toContain("observability_http_403");
    expect(result.runtimeSafety).toEqual({ status: "incomplete", failureCodes: [] });
  });

  it("fails only a repeatable full-window and two-half regression", () => {
    const input = fixture();
    const collector = runtimeWorker(input, "collector");
    collector.samples = collector.samples.map((sample) => ({
      ...sample,
      cpuTimeMs: 30,
    }));
    input.baseline = baseline(10);

    const result = evaluateForecastRuntimeTelemetry(input);

    expect(result.performance.status).toBe("regression");
    expect(result.performance.regressionCodes).toEqual(["runtime_cpu_regression:collector"]);
  });

  it("keeps a one-half spike as a warning rather than a regression failure", () => {
    const input = fixture();
    const split = START + (END - START) / 2;
    const collector = runtimeWorker(input, "collector");
    collector.samples = collector.samples.map((sample) => ({
      ...sample,
      cpuTimeMs: Date.parse(sample.slot) >= split ? 30 : 10,
    }));
    input.baseline = baseline(10);

    const result = evaluateForecastRuntimeTelemetry(input);

    expect(result.performance.status).toBe("warning");
    expect(result.performance.regressionCodes).toEqual([]);
  });

  it("keeps a p95-only regression as a warning", () => {
    const input = fixture();
    runtimeWorker(input, "collector").samples = samplesWithDistribution(slots(0), 10.3375, 16, 16);
    input.baseline = baseline(10);

    const result = evaluateForecastRuntimeTelemetry(input);

    expect(result.performance.status).toBe("warning");
    expect(result.performance.regressionCodes).toEqual([]);
  });

  it("keeps an average-only regression as a warning", () => {
    const input = fixture();
    runtimeWorker(input, "collector").samples = runtimeWorker(input, "collector").samples.map(
      (sample) => ({ ...sample, cpuTimeMs: 13 }),
    );
    input.baseline = baseline(10);

    const result = evaluateForecastRuntimeTelemetry(input);

    expect(result.performance.status).toBe("warning");
    expect(result.performance.regressionCodes).toEqual([]);
  });

  it("rejects telemetry that belongs to a different deployment", () => {
    const input = fixture();
    const sample = runtimeWorker(input, "dispatcher").samples[0];
    if (!sample) throw new Error("missing_dispatcher_sample");
    sample.scriptVersionId = "33333333-3333-4333-8333-333333333333";

    const result = evaluateForecastRuntimeTelemetry(input);

    expect(result.runtimeSafety.status).toBe("failed");
    expect(result.runtimeSafety.failureCodes).toContain(
      "runtime_script_version_mismatch:dispatcher",
    );
  });
});

function fixture() {
  const collectorSlots = slots(0);
  const dispatcherSlots = slots(1);
  const telemetry: ForecastRuntimeTelemetryEvidence = {
    version: 2,
    source: FORECAST_RUNTIME_TELEMETRY_SOURCE,
    canaryId: CANARY_ID,
    deploymentSha: SHA,
    collectorScriptVersion: SHA,
    dispatcherScriptVersion: SHA,
    collectorScriptVersionId: COLLECTOR_VERSION_ID,
    dispatcherScriptVersionId: DISPATCHER_VERSION_ID,
    startedAt: new Date(START).toISOString(),
    endedAt: new Date(END).toISOString(),
    observedAt: new Date(END + 60_000).toISOString(),
    workers: [
      {
        component: "collector",
        ...FORECAST_RUNTIME_WORKERS.collector,
        headSamplingRate: 1,
        samples: samples(collectorSlots, 10, 15),
      },
      {
        component: "dispatcher",
        ...FORECAST_RUNTIME_WORKERS.dispatcher,
        headSamplingRate: 1,
        samples: samples(dispatcherSlots, 5, 7, DISPATCHER_VERSION_ID),
      },
    ],
  };
  return {
    telemetry,
    canaryId: CANARY_ID,
    deploymentSha: SHA,
    collectorScriptVersion: SHA,
    dispatcherScriptVersion: SHA,
    collectorScriptVersionId: COLLECTOR_VERSION_ID,
    dispatcherScriptVersionId: DISPATCHER_VERSION_ID,
    startedAt: new Date(START).toISOString(),
    endedAt: new Date(END).toISOString(),
    collectorExpectedSlots: collectorSlots,
    dispatcherExpectedSlots: dispatcherSlots,
    collectorD1Slots: collectorSlots,
    dispatcherD1Slots: dispatcherSlots,
    baseline: null as CpuPerformanceBaseline | null,
  };
}

function runtimeWorker(input: ReturnType<typeof fixture>, component: "collector" | "dispatcher") {
  const worker = input.telemetry.workers.find((candidate) => candidate.component === component);
  if (!worker) throw new Error(`missing_${component}_worker`);
  return worker;
}

function samples(
  values: string[],
  p95: number,
  p99: number,
  versionId = COLLECTOR_VERSION_ID,
): ForecastRuntimeSample[] {
  return values.map((slot, index) => ({
    slot,
    requestIdHash: index.toString(16).padStart(64, "0"),
    scriptVersionId: versionId,
    scriptVersionTag: SHA,
    identitySource: "tag",
    eventType: "scheduled",
    cpuTimeMs: index < Math.ceil(values.length * 0.95) ? p95 : p99,
    outcome: "ok",
  }));
}

function samplesWithDistribution(
  values: string[],
  average: number,
  p95: number,
  p99: number,
  versionId = COLLECTOR_VERSION_ID,
) {
  const p95Count = 7;
  const p99Count = 2;
  const lowerCount = values.length - p95Count - p99Count;
  const lower = (average * values.length - p95 * p95Count - p99 * p99Count) / lowerCount;
  return values.map((slot, index) => ({
    slot,
    requestIdHash: index.toString(16).padStart(64, "0"),
    scriptVersionId: versionId,
    scriptVersionTag: SHA,
    identitySource: "tag" as const,
    eventType: "scheduled" as const,
    cpuTimeMs: index < lowerCount ? lower : index < lowerCount + p95Count ? p95 : p99,
    outcome: "ok",
  }));
}

function slots(remainder: 0 | 1) {
  const values: string[] = [];
  for (let cursor = Math.floor(START / 60_000) * 60_000 + 60_000; cursor < END; cursor += 60_000) {
    if (new Date(cursor).getUTCMinutes() % 3 === remainder) {
      values.push(new Date(cursor).toISOString());
    }
  }
  return values;
}

function baseline(value: number): CpuPerformanceBaseline {
  const worker = {
    full: { averageMs: value, p95Ms: value },
    firstHalf: { averageMs: value, p95Ms: value },
    secondHalf: { averageMs: value, p95Ms: value },
  };
  return { id: "forecast-runtime-baseline-v1", collector: worker, dispatcher: worker };
}
