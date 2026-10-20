import {
  buildMetricEvidence,
  CLOUDFLARE_PAID_INCLUDED_LIMITS,
  CLOUDFLARE_PAID_THRESHOLDS,
  D1_DATABASE_IDS,
  type D1QuotaEvidence,
} from "../../shared/d1QuotaEvidence";
import { FORECAST_RUNTIME_WORKERS } from "../../shared/forecastCanaryRuntime";
import {
  FORECAST_RUNTIME_TELEMETRY_SOURCE,
  type ForecastRuntimeTelemetryEvidence,
} from "../../shared/forecastCanaryRuntimeEvidence";

export const SHA = "a".repeat(40);
export const CANARY_ID = `fc-${"a".repeat(32)}`;
export const COLLECTOR_VERSION_ID = "11111111-1111-4111-8111-111111111111";
export const DISPATCHER_VERSION_ID = "22222222-2222-4222-8222-222222222222";
export const START = Date.parse("2026-09-01T02:00:30.000Z");
export const END = START + 8 * 60 * 60_000;

export function runtimeTelemetry(): ForecastRuntimeTelemetryEvidence {
  return {
    version: 2,
    source: FORECAST_RUNTIME_TELEMETRY_SOURCE,
    canaryId: CANARY_ID,
    deploymentSha: SHA,
    collectorScriptVersion: `${SHA}-both-v10`,
    dispatcherScriptVersion: `${SHA}-v10`,
    collectorScriptVersionId: COLLECTOR_VERSION_ID,
    dispatcherScriptVersionId: DISPATCHER_VERSION_ID,
    startedAt: new Date(START).toISOString(),
    endedAt: new Date(END).toISOString(),
    observedAt: new Date(END).toISOString(),
    workers: (["collector", "dispatcher"] as const).map((component) => ({
      component,
      ...FORECAST_RUNTIME_WORKERS[component],
      headSamplingRate: 1,
      samples: Array.from({ length: 160 }, (_, index) => ({
        slot: new Date(
          Math.floor(START / 60_000) * 60_000 +
            ((component === "collector" ? 3 : 1) + index * 3) * 60_000,
        ).toISOString(),
        requestIdHash: (index + (component === "collector" ? 1 : 1001))
          .toString(16)
          .padStart(64, "0"),
        scriptVersionId: component === "collector" ? COLLECTOR_VERSION_ID : DISPATCHER_VERSION_ID,
        scriptVersionTag: component === "collector" ? `${SHA}-both-v10` : `${SHA}-v10`,
        identitySource: "tag",
        mode: "on",
        admission: "admitted",
        eventType: "scheduled",
        cpuTimeMs: 5,
        outcome: "ok",
      })),
    })),
  };
}

export function quotaEvidence(nowMs: number): D1QuotaEvidence {
  const names = {
    statsProduction: "collection-kit-stats",
    statsStaging: "collection-kit-stats-staging",
    forecastProduction: "collection-kit-forecast-collector",
    forecastStaging: "collection-kit-forecast-collector-staging",
    usageGuard: "collection-kit-usage-guard",
    statsObserverProduction: "collection-kit-stats-observer",
    statsObserverStaging: "collection-kit-stats-observer-staging",
  };
  const databases = (Object.keys(names) as Array<keyof typeof names>).map((key) => ({
    databaseId: D1_DATABASE_IDS[key],
    databaseName: names[key],
    rowsReadObserved: 1000,
    rowsWrittenObserved: 10,
    storageBytesObserved: 100_000,
  }));
  const workers = [
    "collection-kit-forecast-collector-staging",
    "collection-kit-forecast-dispatcher-staging",
    "collection-kit-forecast-interactions-staging",
    "collection-kit-usage-guard",
  ].map((scriptName) => ({
    scriptName,
    requestsObserved: 1000,
    cpuMsObserved: 5000,
    errorsObserved: 0,
    exceededCpuObserved: 0,
    cpuTimeAverageMs: 5,
    cpuTimeP95Ms: 5,
    cpuTimeP99Ms: 5,
  }));
  const usage = {
    workerRequests: 4000,
    workerCpuMs: 20_000,
    d1RowsRead: 7000,
    d1RowsWritten: 70,
    d1StorageBytes: 700_000,
  };
  const projectedUsage = {
    workerRequests: 100_000,
    workerCpuMs: 500_000,
    d1RowsRead: 1_000_000,
    d1RowsWritten: 10_000,
    d1StorageBytes: 5_000_000,
  };
  const metrics = buildMetricEvidence(usage, projectedUsage);
  const governingMetric = [...metrics].sort(
    (left, right) =>
      Math.max(right.currentPercent, right.projectedPercent) -
        Math.max(left.currentPercent, left.projectedPercent) ||
      left.metric.localeCompare(right.metric),
  )[0]?.metric;
  if (!governingMetric) throw new Error("missing_fixture_metric");
  const observedAt = new Date(nowMs).toISOString();
  return {
    version: 2,
    source: "cloudflare-paid-account-analytics-v2",
    observedAt,
    plan: {
      id: "workers-paid",
      verified: true,
      state: "Paid",
      frequency: "monthly",
      periodStart: "2026-08-15T00:00:00.000Z",
      periodEnd: "2026-09-15T00:00:00.000Z",
    },
    limits: CLOUDFLARE_PAID_INCLUDED_LIMITS,
    thresholds: CLOUDFLARE_PAID_THRESHOLDS,
    usage,
    projectedUsage,
    metrics,
    utilization: {
      currentPercent: Math.max(...metrics.map((metric) => metric.currentPercent)),
      projectedPercent: Math.max(...metrics.map((metric) => metric.projectedPercent)),
      governingMetric,
    },
    action: "normal",
    databases,
    workers,
    workerRuntime: {
      startedAt: new Date(nowMs - 8 * 60 * 60_000).toISOString(),
      endedAt: observedAt,
      workers,
    },
    passed: true,
  };
}

export function runtimeQuotaEvidence() {
  const evidence = quotaEvidence(END);
  return {
    action: evidence.action,
    observedAt: evidence.observedAt,
    periodStart: evidence.plan.periodStart,
    periodEnd: evidence.plan.periodEnd,
    evidenceHash: "f".repeat(64),
    evidence,
  };
}
