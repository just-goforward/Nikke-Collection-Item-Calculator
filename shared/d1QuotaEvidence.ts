import { z } from "zod/mini";

export const CLOUDFLARE_PAID_INCLUDED_LIMITS = {
  workerRequests: 10_000_000,
  workerCpuMs: 30_000_000,
  d1RowsRead: 25_000_000_000,
  d1RowsWritten: 50_000_000,
  d1StorageBytes: 5_000_000_000,
} as const;

export const CLOUDFLARE_PAID_THRESHOLDS = {
  warningPercent: 25,
  disableStagingPercent: 35,
  disableForecastProductionPercent: 40,
  disableStatisticsWritesPercent: 45,
  hardStopPercent: 50,
  safetyFactor: 2,
  burnInMinutes: 30,
  canaryHours: 8,
  evidenceWarningMinutes: 45,
  evidenceHardStopMinutes: 120,
} as const;

export const D1_DATABASE_IDS = {
  statsProduction: "3e18385a-af83-4c67-83a0-ab889149692c",
  statsStaging: "95f4029b-669a-4e1e-a192-5c094e659e33",
  forecastProduction: "2d58bcc0-a7b5-43f3-8f42-34e1bf1ff853",
  forecastStaging: "49b5dc06-37ae-4245-896c-daea98562ed8",
  usageGuard: "49b7f966-f4e8-4c2d-8453-279415737054",
} as const;

export const QUOTA_ACTIONS = [
  "normal",
  "warning",
  "disable_staging",
  "disable_forecast_production",
  "disable_statistics_writes",
  "hard_stop",
] as const;

export type CloudflareQuotaAction = (typeof QUOTA_ACTIONS)[number];
export type CloudflareQuotaMetric = keyof typeof CLOUDFLARE_PAID_INCLUDED_LIMITS;

const timestampSchema = z.string().check(z.iso.datetime({ offset: false }));
const countSchema = z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER));
const percentSchema = z.number().check(z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER));
const quotaMetricSchema = z.enum([
  "workerRequests",
  "workerCpuMs",
  "d1RowsRead",
  "d1RowsWritten",
  "d1StorageBytes",
]);
const quotaActionSchema = z.enum(QUOTA_ACTIONS);

const metricEvidenceSchema = z.object({
  metric: quotaMetricSchema,
  observed: countSchema,
  projected: countSchema,
  limit: countSchema,
  currentPercent: percentSchema,
  projectedPercent: percentSchema,
});

const databaseEvidenceSchema = z.object({
  databaseId: z.string().check(z.minLength(1), z.maxLength(80)),
  databaseName: z.string().check(z.minLength(1), z.maxLength(128)),
  rowsReadObserved: countSchema,
  rowsWrittenObserved: countSchema,
  storageBytesObserved: countSchema,
});

const workerEvidenceSchema = z.object({
  scriptName: z.string().check(z.minLength(1), z.maxLength(128)),
  requestsObserved: countSchema,
  cpuMsObserved: countSchema,
  errorsObserved: countSchema,
  exceededCpuObserved: countSchema,
  cpuTimeAverageMs: z.number().check(z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)),
  cpuTimeP95Ms: z.number().check(z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)),
  cpuTimeP99Ms: z.number().check(z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)),
});

export const cloudflarePaidQuotaEvidenceSchema = z.object({
  version: z.literal(2),
  source: z.literal("cloudflare-paid-account-analytics-v2"),
  observedAt: timestampSchema,
  plan: z.object({
    id: z.literal("workers-paid"),
    verified: z.literal(true),
    state: z.literal("Paid"),
    frequency: z.literal("monthly"),
    periodStart: timestampSchema,
    periodEnd: timestampSchema,
  }),
  limits: z.object({
    workerRequests: z.literal(CLOUDFLARE_PAID_INCLUDED_LIMITS.workerRequests),
    workerCpuMs: z.literal(CLOUDFLARE_PAID_INCLUDED_LIMITS.workerCpuMs),
    d1RowsRead: z.literal(CLOUDFLARE_PAID_INCLUDED_LIMITS.d1RowsRead),
    d1RowsWritten: z.literal(CLOUDFLARE_PAID_INCLUDED_LIMITS.d1RowsWritten),
    d1StorageBytes: z.literal(CLOUDFLARE_PAID_INCLUDED_LIMITS.d1StorageBytes),
  }),
  thresholds: z.object({
    warningPercent: z.literal(CLOUDFLARE_PAID_THRESHOLDS.warningPercent),
    disableStagingPercent: z.literal(CLOUDFLARE_PAID_THRESHOLDS.disableStagingPercent),
    disableForecastProductionPercent: z.literal(
      CLOUDFLARE_PAID_THRESHOLDS.disableForecastProductionPercent,
    ),
    disableStatisticsWritesPercent: z.literal(
      CLOUDFLARE_PAID_THRESHOLDS.disableStatisticsWritesPercent,
    ),
    hardStopPercent: z.literal(CLOUDFLARE_PAID_THRESHOLDS.hardStopPercent),
    safetyFactor: z.literal(CLOUDFLARE_PAID_THRESHOLDS.safetyFactor),
    burnInMinutes: z.literal(CLOUDFLARE_PAID_THRESHOLDS.burnInMinutes),
    canaryHours: z.literal(CLOUDFLARE_PAID_THRESHOLDS.canaryHours),
    evidenceWarningMinutes: z.literal(CLOUDFLARE_PAID_THRESHOLDS.evidenceWarningMinutes),
    evidenceHardStopMinutes: z.literal(CLOUDFLARE_PAID_THRESHOLDS.evidenceHardStopMinutes),
  }),
  usage: z.object({
    workerRequests: countSchema,
    workerCpuMs: countSchema,
    d1RowsRead: countSchema,
    d1RowsWritten: countSchema,
    d1StorageBytes: countSchema,
  }),
  projectedUsage: z.object({
    workerRequests: countSchema,
    workerCpuMs: countSchema,
    d1RowsRead: countSchema,
    d1RowsWritten: countSchema,
    d1StorageBytes: countSchema,
  }),
  metrics: z.array(metricEvidenceSchema).check(z.length(5)),
  utilization: z.object({
    currentPercent: percentSchema,
    projectedPercent: percentSchema,
    governingMetric: quotaMetricSchema,
  }),
  action: quotaActionSchema,
  databases: z.array(databaseEvidenceSchema).check(z.minLength(5), z.maxLength(100)),
  workers: z.array(workerEvidenceSchema).check(z.maxLength(500)),
  workerRuntime: z.object({
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    workers: z.array(workerEvidenceSchema).check(z.maxLength(500)),
  }),
  passed: z.boolean(),
});

export type D1QuotaEvidence = z.infer<typeof cloudflarePaidQuotaEvidenceSchema>;
export type D1DatabaseEvidence = D1QuotaEvidence["databases"][number];
export type WorkerQuotaEvidence = D1QuotaEvidence["workers"][number];

export function quotaActionForPercent(percent: number): CloudflareQuotaAction {
  if (!Number.isFinite(percent) || percent < 0) return "hard_stop";
  if (percent >= CLOUDFLARE_PAID_THRESHOLDS.hardStopPercent) return "hard_stop";
  if (percent >= CLOUDFLARE_PAID_THRESHOLDS.disableStatisticsWritesPercent)
    return "disable_statistics_writes";
  if (percent >= CLOUDFLARE_PAID_THRESHOLDS.disableForecastProductionPercent)
    return "disable_forecast_production";
  if (percent >= CLOUDFLARE_PAID_THRESHOLDS.disableStagingPercent) return "disable_staging";
  if (percent >= CLOUDFLARE_PAID_THRESHOLDS.warningPercent) return "warning";
  return "normal";
}

export function assertD1QuotaEvidence(value: unknown): D1QuotaEvidence {
  const evidence = cloudflarePaidQuotaEvidenceSchema.parse(value);
  const { periodStart, observedAt } = assertEvidencePeriod(evidence);
  assertWorkerRuntimePeriod(evidence, periodStart, observedAt);
  assertWorkerMetrics(evidence);
  assertDetailIdentityAndTotals(evidence);
  const expectedMetrics = assertMetricEvidence(evidence);
  const utilization = expectedUtilization(expectedMetrics);
  assertUtilization(evidence, utilization);
  assertActionAndPassed(evidence, utilization);
  return evidence;
}

function assertDetailIdentityAndTotals(evidence: D1QuotaEvidence) {
  assertUnique(
    evidence.databases.map((database) => database.databaseId),
    "database",
  );
  assertUnique(
    evidence.workers.map((worker) => worker.scriptName),
    "worker",
  );
  assertUnique(
    evidence.workerRuntime.workers.map((worker) => worker.scriptName),
    "runtime_worker",
  );
  const databaseIds = new Set(evidence.databases.map((database) => database.databaseId));
  for (const databaseId of Object.values(D1_DATABASE_IDS)) {
    if (!databaseIds.has(databaseId)) {
      throw new Error(`cloudflare_paid_quota_required_database_missing:${databaseId}`);
    }
  }
  assertEqual(
    evidence.usage.workerRequests,
    sum(evidence.workers, "requestsObserved"),
    "cloudflare_paid_quota_worker_requests_mismatch",
  );
  assertEqual(
    evidence.usage.workerCpuMs,
    sum(evidence.workers, "cpuMsObserved"),
    "cloudflare_paid_quota_worker_cpu_mismatch",
  );
  assertEqual(
    evidence.usage.d1RowsRead,
    sum(evidence.databases, "rowsReadObserved"),
    "cloudflare_paid_quota_d1_reads_mismatch",
  );
  assertEqual(
    evidence.usage.d1RowsWritten,
    sum(evidence.databases, "rowsWrittenObserved"),
    "cloudflare_paid_quota_d1_writes_mismatch",
  );
  assertEqual(
    evidence.usage.d1StorageBytes,
    sum(evidence.databases, "storageBytesObserved"),
    "cloudflare_paid_quota_d1_storage_mismatch",
  );
}

function assertEvidencePeriod(evidence: D1QuotaEvidence) {
  const periodStart = Date.parse(evidence.plan.periodStart);
  const periodEnd = Date.parse(evidence.plan.periodEnd);
  const observedAt = Date.parse(evidence.observedAt);
  if (!(periodStart < periodEnd && periodStart <= observedAt && observedAt < periodEnd)) {
    throw new Error("cloudflare_paid_quota_period_invalid");
  }
  return { periodStart, observedAt };
}

function assertWorkerRuntimePeriod(
  evidence: D1QuotaEvidence,
  periodStart: number,
  observedAt: number,
) {
  const runtimeStart = Date.parse(evidence.workerRuntime.startedAt);
  const runtimeEnd = Date.parse(evidence.workerRuntime.endedAt);
  const maximumRuntimeMs = CLOUDFLARE_PAID_THRESHOLDS.canaryHours * 60 * 60 * 1_000;
  if (
    !(periodStart <= runtimeStart && runtimeStart < runtimeEnd) ||
    runtimeEnd > observedAt ||
    runtimeEnd - runtimeStart > maximumRuntimeMs
  ) {
    throw new Error("cloudflare_paid_quota_worker_runtime_invalid");
  }
}

function assertWorkerMetrics(evidence: D1QuotaEvidence) {
  for (const worker of [...evidence.workers, ...evidence.workerRuntime.workers]) {
    const expectedAverage =
      worker.requestsObserved > 0 ? worker.cpuMsObserved / worker.requestsObserved : 0;
    if (
      worker.cpuTimeAverageMs !== expectedAverage ||
      worker.cpuTimeP95Ms > worker.cpuTimeP99Ms ||
      worker.exceededCpuObserved > worker.requestsObserved
    ) {
      throw new Error("cloudflare_paid_quota_worker_metrics_invalid");
    }
  }
}

function assertMetricEvidence(evidence: D1QuotaEvidence) {
  const expectedMetrics = buildMetricEvidence(evidence.usage, evidence.projectedUsage);
  if (JSON.stringify(expectedMetrics) !== JSON.stringify(evidence.metrics)) {
    throw new Error("cloudflare_paid_quota_metrics_mismatch");
  }
  return expectedMetrics;
}

function expectedUtilization(expectedMetrics: D1QuotaEvidence["metrics"]) {
  const governing = [...expectedMetrics].sort(
    (left, right) =>
      Math.max(right.currentPercent, right.projectedPercent) -
        Math.max(left.currentPercent, left.projectedPercent) ||
      left.metric.localeCompare(right.metric),
  )[0];
  if (!governing) throw new Error("cloudflare_paid_quota_governing_metric_missing");
  const currentPercent = Math.max(...expectedMetrics.map((metric) => metric.currentPercent));
  const projectedPercent = Math.max(...expectedMetrics.map((metric) => metric.projectedPercent));
  return { currentPercent, projectedPercent, governingMetric: governing.metric };
}

function assertUtilization(
  evidence: D1QuotaEvidence,
  utilization: ReturnType<typeof expectedUtilization>,
) {
  if (
    evidence.utilization.currentPercent !== utilization.currentPercent ||
    evidence.utilization.projectedPercent !== utilization.projectedPercent ||
    evidence.utilization.governingMetric !== utilization.governingMetric
  ) {
    throw new Error("cloudflare_paid_quota_utilization_mismatch");
  }
}

function assertActionAndPassed(
  evidence: D1QuotaEvidence,
  utilization: ReturnType<typeof expectedUtilization>,
) {
  const expectedAction = quotaActionForPercent(
    Math.max(utilization.currentPercent, utilization.projectedPercent),
  );
  if (evidence.action !== expectedAction) throw new Error("cloudflare_paid_quota_action_mismatch");
  if (evidence.passed !== (expectedAction === "normal")) {
    throw new Error("cloudflare_paid_quota_passed_mismatch");
  }
}

export function buildMetricEvidence(
  usage: D1QuotaEvidence["usage"],
  projected: D1QuotaEvidence["projectedUsage"],
): D1QuotaEvidence["metrics"] {
  const values: Array<[CloudflareQuotaMetric, number, number]> = [
    ["workerRequests", usage.workerRequests, projected.workerRequests],
    ["workerCpuMs", usage.workerCpuMs, projected.workerCpuMs],
    ["d1RowsRead", usage.d1RowsRead, projected.d1RowsRead],
    ["d1RowsWritten", usage.d1RowsWritten, projected.d1RowsWritten],
    ["d1StorageBytes", usage.d1StorageBytes, projected.d1StorageBytes],
  ];
  return values.map(([metric, observed, projectedValue]) => {
    const limit = CLOUDFLARE_PAID_INCLUDED_LIMITS[metric];
    return {
      metric,
      observed,
      projected: projectedValue,
      limit,
      currentPercent: percent(observed, limit),
      projectedPercent: percent(projectedValue, limit),
    };
  });
}

function percent(value: number, limit: number) {
  return Math.round((value / limit) * 100_000_000) / 1_000_000;
}

function assertUnique(values: string[], kind: string) {
  if (new Set(values).size !== values.length) {
    throw new Error(`cloudflare_paid_quota_duplicate_${kind}`);
  }
}

function sum<T extends Record<K, number>, K extends keyof T>(values: T[], key: K) {
  return values.reduce((total, value) => total + value[key], 0);
}

function assertEqual(actual: number, expected: number, code: string) {
  if (actual !== expected) throw new Error(code);
}
