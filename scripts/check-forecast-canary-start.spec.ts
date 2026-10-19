import { expect, it } from "vitest";
import {
  FORECAST_RUNTIME_TELEMETRY_SOURCE,
  FORECAST_RUNTIME_WORKERS,
  type ForecastRuntimeTelemetryEvidence,
} from "../shared/forecastCanaryRuntime";
import { assertV2CanaryStart } from "./check-forecast-canary-start";

const now = Date.parse("2026-09-01T00:02:20Z");
const expected = {
  deploymentSha: "a".repeat(40),
  collectorVersionId: "11111111-1111-4111-8111-111111111111",
  dispatcherVersionId: "22222222-2222-4222-8222-222222222222",
};

function fixture(): ForecastRuntimeTelemetryEvidence {
  return {
    version: 2,
    source: FORECAST_RUNTIME_TELEMETRY_SOURCE,
    canaryId: `fc-${"a".repeat(32)}`,
    deploymentSha: expected.deploymentSha,
    collectorScriptVersion: `${expected.deploymentSha}-both-v10`,
    dispatcherScriptVersion: `${expected.deploymentSha}-v10`,
    collectorScriptVersionId: expected.collectorVersionId,
    dispatcherScriptVersionId: expected.dispatcherVersionId,
    startedAt: "2026-08-31T23:56:00.000Z",
    endedAt: "2026-09-01T00:02:10.000Z",
    observedAt: "2026-09-01T00:02:15.000Z",
    workers: (["collector", "dispatcher"] as const).map((component) => ({
      component,
      ...FORECAST_RUNTIME_WORKERS[component],
      headSamplingRate: 1,
      samples: [
        {
          slot: component === "collector" ? "2026-09-01T00:00:00.000Z" : "2026-09-01T00:01:00.000Z",
          requestIdHash: (component === "collector" ? "a" : "b").repeat(64),
          scriptVersionId:
            component === "collector" ? expected.collectorVersionId : expected.dispatcherVersionId,
          scriptVersionTag: null,
          identitySource: "version_id",
          eventType: "scheduled",
          cpuTimeMs: 5,
          outcome: "ok",
        },
      ],
    })),
  };
}

it("accepts an independently version-bound completed Cron pair in the safe start phase", () => {
  expect(() => assertV2CanaryStart(fixture(), expected, now)).not.toThrow();
});

it.each(["collector", "dispatcher"] as const)("blocks missing %s evidence", (component) => {
  const value = fixture();
  const worker = value.workers.find((entry) => entry.component === component);
  if (!worker) throw new Error("fixture_missing");
  worker.samples = [];
  expect(() => assertV2CanaryStart(value, expected, now)).toThrow(
    "canary_start_completed_pair_missing",
  );
});

it("blocks stale observations and a stale scheduled pair", () => {
  const value = fixture();
  value.observedAt = "2026-08-31T23:59:00.000Z";
  expect(() => assertV2CanaryStart(value, expected, now)).toThrow("canary_start_evidence_stale");
  const stale = fixture();
  for (const worker of stale.workers)
    for (const sample of worker.samples) sample.slot = "2026-08-31T23:57:00.000Z";
  expect(() => assertV2CanaryStart(stale, expected, now)).toThrow(
    "canary_start_completed_pair_missing",
  );
});

it("blocks mismatched header and sample version IDs", () => {
  const value = fixture();
  value.collectorScriptVersionId = expected.dispatcherVersionId;
  expect(() => assertV2CanaryStart(value, expected, now)).toThrow("canary_start_version_mismatch");
  const unbound = fixture();
  for (const worker of unbound.workers)
    for (const sample of worker.samples) {
      sample.scriptVersionId = null;
      sample.identitySource = "marker";
    }
  expect(() => assertV2CanaryStart(unbound, expected, now)).toThrow(
    "canary_start_completed_pair_missing",
  );
});

it("blocks failed runtime outcomes and unsafe start phases", () => {
  const value = fixture();
  for (const worker of value.workers)
    for (const sample of worker.samples) sample.outcome = "exceededCpu";
  expect(() => assertV2CanaryStart(value, expected, now)).toThrow(
    "canary_start_completed_pair_missing",
  );
  expect(() => assertV2CanaryStart(fixture(), expected, now - 60_000)).toThrow(
    "canary_start_phase_invalid",
  );
});
