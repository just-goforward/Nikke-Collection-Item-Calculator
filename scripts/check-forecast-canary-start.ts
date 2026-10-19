import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertForecastRuntimeTelemetryEvidence,
  FORECAST_RUNTIME_EVIDENCE_MAX_AGE_MS,
  FORECAST_RUNTIME_WORKERS,
  type ForecastRuntimeTelemetryEvidence,
  isAdmittedV2Sample,
  isSuccessfulOutcome,
} from "../shared/forecastCanaryRuntime.ts";

type Expected = {
  deploymentSha: string;
  collectorVersionId: string;
  dispatcherVersionId: string;
};

export function assertV2CanaryStart(raw: unknown, expected: Expected, nowMs: number) {
  const evidence = assertForecastRuntimeTelemetryEvidence(raw);
  const now = new Date(nowMs);
  if (now.getUTCMinutes() % 3 !== 2 || now.getUTCSeconds() < 10 || now.getUTCSeconds() > 40)
    throw new Error("canary_start_phase_invalid");
  if (
    evidence.deploymentSha !== expected.deploymentSha ||
    evidence.collectorScriptVersionId !== expected.collectorVersionId ||
    evidence.dispatcherScriptVersionId !== expected.dispatcherVersionId
  )
    throw new Error("canary_start_version_mismatch");
  for (const timestamp of [evidence.endedAt, evidence.observedAt]) {
    const age = nowMs - Date.parse(timestamp);
    if (age < 0 || age > FORECAST_RUNTIME_EVIDENCE_MAX_AGE_MS)
      throw new Error("canary_start_evidence_stale");
  }
  if (evidence.collectionErrors?.length) throw new Error("canary_start_collection_incomplete");
  assertCompletedPair(evidence, expected, nowMs);
}

function assertCompletedPair(
  evidence: ForecastRuntimeTelemetryEvidence,
  expected: Expected,
  nowMs: number,
) {
  const cycle = Math.floor(nowMs / 180_000) * 180_000;
  for (const component of ["collector", "dispatcher"] as const) {
    const worker = evidence.workers.find((row) => row.component === component);
    const slot = cycle + (component === "collector" ? 0 : 60_000);
    const matching = worker?.samples.filter(
      (sample) =>
        (component !== "collector" || isAdmittedV2Sample(sample)) &&
        Math.floor(Date.parse(sample.slot) / 60_000) * 60_000 === slot &&
        Date.parse(sample.slot) >= Date.parse(evidence.startedAt) &&
        Date.parse(sample.slot) < Date.parse(evidence.endedAt),
    );
    const sample = matching?.[0];
    const version =
      component === "collector" ? expected.collectorVersionId : expected.dispatcherVersionId;
    if (
      worker?.scriptName !== FORECAST_RUNTIME_WORKERS[component].scriptName ||
      matching?.length !== 1 ||
      !sample ||
      sample.scriptVersionId !== version ||
      sample.cpuTimeMs === null ||
      !sample.outcome ||
      !isSuccessfulOutcome(sample.outcome)
    )
      throw new Error(`canary_start_completed_pair_missing:${component}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error("canary_start_evidence_file_required");
  assertV2CanaryStart(
    JSON.parse(readFileSync(file, "utf8")),
    {
      deploymentSha: process.env["FORECAST_CANARY_DEPLOYMENT_SHA"] ?? "",
      collectorVersionId: process.env["FORECAST_COLLECTOR_SCRIPT_VERSION_ID"] ?? "",
      dispatcherVersionId: process.env["FORECAST_DISPATCHER_SCRIPT_VERSION_ID"] ?? "",
    },
    Date.now(),
  );
}
