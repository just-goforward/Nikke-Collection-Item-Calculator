import { writeFile } from "node:fs/promises";
import {
  collectForecastRuntimeTelemetry,
  unavailableForecastRuntimeTelemetry,
} from "./lib/cloudflare-workers-observability.ts";

const mode = process.argv[2] ?? "collect";
if (mode !== "collect" && mode !== "preflight") {
  throw new Error("Usage: cloudflare-workers-observability.ts [collect|preflight]");
}

const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
const token =
  mode === "preflight"
    ? requiredEnvironment("CLOUDFLARE_WORKERS_OBSERVABILITY_TOKEN")
    : (process.env["CLOUDFLARE_WORKERS_OBSERVABILITY_TOKEN"] ?? "");
const canaryId = requiredEnvironment("FORECAST_CANARY_ID");
const deploymentSha = requiredEnvironment("FORECAST_CANARY_DEPLOYMENT_SHA");
const startedAt = requiredTimestamp("FORECAST_CANARY_STARTED_AT");
const endedAt = requiredTimestamp("FORECAST_CANARY_ENDED_AT");
const collectorScriptVersion = requiredEnvironment("FORECAST_COLLECTOR_SCRIPT_VERSION");
const dispatcherScriptVersion = requiredEnvironment("FORECAST_DISPATCHER_SCRIPT_VERSION");
const collectorScriptVersionId = requiredEnvironment("FORECAST_COLLECTOR_SCRIPT_VERSION_ID");
const dispatcherScriptVersionId = requiredEnvironment("FORECAST_DISPATCHER_SCRIPT_VERSION_ID");
const output = requiredEnvironment("FORECAST_CANARY_RUNTIME_OUTPUT");
const maxWaitMs =
  mode === "preflight" ? 0 : optionalUnsigned("FORECAST_OBSERVABILITY_MAX_WAIT_MS", 0);
const retryIntervalMs = optionalUnsigned("FORECAST_OBSERVABILITY_RETRY_INTERVAL_MS", 300_000);
const deadline = Date.now() + maxWaitMs;
let evidence: Awaited<ReturnType<typeof collect>>;
let preflightError: Error | null = null;
try {
  evidence = await collect();
  while (!hasExpectedCoverage(evidence) && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryIntervalMs, remaining)));
    evidence = await collect();
  }
} catch (error) {
  evidence = unavailableForecastRuntimeTelemetry(
    {
      canaryId,
      deploymentSha,
      startedAt,
      endedAt,
      collectorScriptVersion,
      dispatcherScriptVersion,
      collectorScriptVersionId,
      dispatcherScriptVersionId,
    },
    error,
  );
  console.warn(`Workers Observability evidence is incomplete: ${evidence.collectionErrors?.[0]}`);
  if (mode === "preflight") {
    preflightError = error instanceof Error ? error : new Error("observability_request_failed");
  }
}

await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
if (preflightError) throw preflightError;
if (mode === "preflight" && evidence.workers.some((worker) => worker.samples.length === 0)) {
  throw new Error("observability_preflight_has_no_scheduled_samples");
}
console.log(
  JSON.stringify({
    source: evidence.source,
    canaryId: evidence.canaryId,
    workers: evidence.workers.map((worker) => ({
      component: worker.component,
      samples: worker.samples.length,
    })),
  }),
);

function collect() {
  return collectForecastRuntimeTelemetry({
    accountId,
    token,
    canaryId,
    deploymentSha,
    startedAt,
    endedAt,
    collectorScriptVersion,
    dispatcherScriptVersion,
    collectorScriptVersionId,
    dispatcherScriptVersionId,
  });
}

function hasExpectedCoverage(value: Awaited<ReturnType<typeof collect>>) {
  const expected = expectedSlotCount(Date.parse(startedAt), Date.parse(endedAt));
  return value.workers.every((worker) => worker.samples.length >= expected - 1);
}

function expectedSlotCount(startedMs: number, endedMs: number) {
  let count = 0;
  for (
    let cursor = (Math.floor(startedMs / 60_000) + 1) * 60_000;
    cursor < endedMs;
    cursor += 60_000
  ) {
    if (new Date(cursor).getUTCMinutes() % 3 === 0) count += 1;
  }
  return count;
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function requiredTimestamp(name: string) {
  const value = requiredEnvironment(name);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${name}.`);
  return new Date(Date.parse(value)).toISOString();
}

function optionalUnsigned(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid ${name}.`);
  return value;
}
