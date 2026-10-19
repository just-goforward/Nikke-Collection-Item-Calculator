import { expect, it } from "vitest";
import {
  evaluateForecastRuntimeTelemetry,
  FORECAST_RUNTIME_TELEMETRY_SOURCE,
  FORECAST_RUNTIME_WORKERS,
  type ForecastRuntimeTelemetryEvidence,
} from "./forecastCanaryRuntime";

function fixture() {
  const sha = "a".repeat(40);
  const start = Date.parse("2026-09-01T00:00:30Z");
  const end = start + 8 * 60 * 60_000;
  const versions = {
    collector: "11111111-1111-4111-8111-111111111111",
    dispatcher: "22222222-2222-4222-8222-222222222222",
  };
  const slots = (offset: number) =>
    Array.from({ length: 160 }, (_, i) =>
      new Date(start - 30_000 + (offset + i * 3) * 60_000).toISOString(),
    );
  const telemetry: ForecastRuntimeTelemetryEvidence = {
    version: 2,
    source: FORECAST_RUNTIME_TELEMETRY_SOURCE,
    canaryId: `fc-${"a".repeat(32)}`,
    deploymentSha: sha,
    collectorScriptVersion: sha,
    dispatcherScriptVersion: sha,
    collectorScriptVersionId: versions.collector,
    dispatcherScriptVersionId: versions.dispatcher,
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(end).toISOString(),
    observedAt: new Date(end).toISOString(),
    workers: (["collector", "dispatcher"] as const).map((component) => ({
      component,
      ...FORECAST_RUNTIME_WORKERS[component],
      headSamplingRate: 1,
      samples: slots(component === "collector" ? 3 : 1).map((slot, i) => ({
        slot,
        requestIdHash: (i + 1).toString(16).padStart(64, "0"),
        scriptVersionId: versions[component],
        scriptVersionTag: sha,
        identitySource: "tag",
        eventType: "scheduled",
        cpuTimeMs: 5,
        outcome: "ok",
      })),
    })),
  };
  return {
    coverageBasis: "scheduled" as const,
    nowMs: end,
    telemetry,
    canaryId: telemetry.canaryId,
    deploymentSha: sha,
    collectorScriptVersion: sha,
    dispatcherScriptVersion: sha,
    collectorScriptVersionId: versions.collector,
    dispatcherScriptVersionId: versions.dispatcher,
    startedAt: telemetry.startedAt,
    endedAt: telemetry.endedAt,
    collectorExpectedSlots: slots(3),
    dispatcherExpectedSlots: slots(1),
  };
}

it("uses Cron slots as the denominator and reports zero D1 invocation evidence", () => {
  const result = evaluateForecastRuntimeTelemetry(fixture());
  expect(result.runtimeSafety.status).toBe("passed");
  expect(result.performance.collector).toMatchObject({
    coverageBasis: "scheduled",
    d1ObservedSlots: 0,
    expectedSlots: 160,
    coverage: 1,
    runtimeCoverage: 1,
  });
});

it("blocks a missing component rather than accepting healthy monitor rows as telemetry", () => {
  const input = fixture();
  input.telemetry.workers = input.telemetry.workers.filter(
    (worker) => worker.component !== "collector",
  );
  const result = evaluateForecastRuntimeTelemetry(input);
  expect(result.evidence.status).toBe("incomplete");
  expect(result.runtimeSafety.status).toBe("incomplete");
});

it.each([-1, 180_001])("blocks future/stale telemetry with observation age %d", (age) => {
  const input = fixture();
  input.nowMs += age;
  expect(evaluateForecastRuntimeTelemetry(input).evidence.errors).toContain(
    "runtime_observation_stale_or_future",
  );
});

it.each(["tag", "id"])("blocks forged version %s on a complete scheduled sample set", (field) => {
  const input = fixture();
  const sample = input.telemetry.workers[0]?.samples[0];
  if (!sample) throw new Error("fixture_missing");
  if (field === "tag") sample.scriptVersionTag = "wrong-version";
  else sample.scriptVersionId = "33333333-3333-4333-8333-333333333333";
  expect(evaluateForecastRuntimeTelemetry(input).runtimeSafety.failureCodes).toContain(
    "runtime_script_version_mismatch:collector",
  );
});

it("does not treat a matching mutable tag as a deployed version ID", () => {
  const input = fixture();
  const sample = input.telemetry.workers[0]?.samples[0];
  if (!sample) throw new Error("fixture_missing");
  sample.scriptVersionId = null;
  expect(evaluateForecastRuntimeTelemetry(input).evidence.errors).toContain(
    "runtime_version_metadata_missing:collector",
  );
});

it("requires completion evidence when no D1 invocation ledger can provide it", () => {
  const input = fixture();
  const worker = input.telemetry.workers[0];
  if (!worker) throw new Error("fixture_missing");
  for (const sample of worker.samples.slice(0, 2)) {
    sample.cpuTimeMs = null;
    sample.outcome = null;
  }
  expect(evaluateForecastRuntimeTelemetry(input).evidence.errors).toContain(
    "runtime_completion_coverage_incomplete:collector",
  );
});
