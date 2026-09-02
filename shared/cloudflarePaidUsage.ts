import { readBoundedJson } from "./boundedHttp.ts";
import { listCloudflareD1Databases } from "./cloudflareD1Catalog.ts";
import { CLOUDFLARE_PAID_USAGE_QUERY } from "./cloudflarePaidUsageQuery.ts";
import {
  assertWorkerRuntimeWindowPair,
  resolveWorkerRuntimeWindow,
} from "./cloudflareWorkerRuntimeWindow.ts";
import {
  assertD1QuotaEvidence,
  buildMetricEvidence,
  CLOUDFLARE_PAID_INCLUDED_LIMITS,
  CLOUDFLARE_PAID_THRESHOLDS,
  D1_DATABASE_IDS,
  type D1QuotaEvidence,
  quotaActionForPercent,
} from "./d1QuotaEvidence.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const API_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
const API_TIMEOUT_MS = 20_000;
const GRAPHQL_GROUP_LIMIT = 10_000;
const WORKER_RUNTIME_WINDOW_MS = 8 * 60 * 60 * 1_000;
const readCloudflareJson = (response: Response) =>
  readBoundedJson(response, API_RESPONSE_LIMIT_BYTES, "cloudflare_api_response_too_large");

export type CloudflarePaidPlan = {
  id: "workers-paid";
  verified: true;
  state: "Paid";
  frequency: "monthly";
  periodStart: string;
  periodEnd: string;
  subscriptionId: string;
  ratePlanId: string;
};

export type AccountDailyUsage = {
  date: string;
  workerRequests: number;
  workerCpuMs: number;
  d1RowsRead: number;
  d1RowsWritten: number;
};

export type D1UsageDatabase = {
  databaseId: string;
  databaseName: string;
  rowsReadObserved: number;
  rowsWrittenObserved: number;
  storageBytesObserved: number;
};

export type WorkerUsage = {
  scriptName: string;
  requestsObserved: number;
  cpuMsObserved: number;
  errorsObserved: number;
  exceededCpuObserved: number;
  cpuTimeAverageMs: number;
  cpuTimeP95Ms: number;
  cpuTimeP99Ms: number;
};

export type WorkerRuntimeUsage = {
  startedAt: string;
  endedAt: string;
  workers: WorkerUsage[];
};

export type CloudflarePaidUsageSnapshot = {
  version: 2;
  source: "cloudflare-paid-account-analytics-v2";
  accountId: string;
  capturedAt: string;
  plan: CloudflarePaidPlan;
  daily: AccountDailyUsage[];
  databases: D1UsageDatabase[];
  workers: WorkerUsage[];
  workerRuntime: WorkerRuntimeUsage;
};

export type D1UsageSnapshot = CloudflarePaidUsageSnapshot;

export type D1BudgetEvaluation = {
  version: 2;
  passed: boolean;
  action: D1QuotaEvidence["action"];
  reasons: string[];
  evidence: D1QuotaEvidence | null;
  metrics: {
    currentPercent: number;
    projectedPercent: number;
    governingMetric: D1QuotaEvidence["utilization"]["governingMetric"];
    workerRequestsProjected: number;
    workerCpuMsProjected: number;
    d1RowsReadProjected: number;
    d1RowsWrittenProjected: number;
    d1StorageBytesProjected: number;
  };
};

type UsageTotals = D1QuotaEvidence["usage"];

type CloudflarePaidUsageInput = {
  accountId: string;
  analyticsToken: string;
  billingToken: string;
  nowMs?: number;
  runtimeStartedAt?: string;
  runtimeEndedAt?: string;
  fetchImpl?: typeof fetch;
};

export async function fetchCloudflarePaidUsageSnapshot(
  input: CloudflarePaidUsageInput,
): Promise<CloudflarePaidUsageSnapshot> {
  assertCloudflarePaidUsageInput(input);

  const fetchImpl = input.fetchImpl ?? fetch;
  const nowMs = input.nowMs ?? Date.now();
  const plan = await fetchPaidPlan(fetchImpl, input.accountId, input.billingToken, nowMs);
  const startDate = utcDate(Date.parse(plan.periodStart));
  const endDate = utcDate(nowMs);
  const capturedAt = new Date(nowMs).toISOString();
  const { runtimeStartedAt, runtimeEndedAt } = resolveWorkerRuntimeWindow(
    { startedAt: input.runtimeStartedAt, endedAt: input.runtimeEndedAt },
    nowMs,
    plan.periodStart,
    WORKER_RUNTIME_WINDOW_MS,
  );
  const [databaseNames, analytics] = await Promise.all([
    listCloudflareD1Databases(fetchImpl, input.accountId, input.analyticsToken),
    queryAccountAnalytics(
      fetchImpl,
      input.accountId,
      input.analyticsToken,
      startDate,
      endDate,
      plan.periodStart,
      capturedAt,
      runtimeStartedAt,
      runtimeEndedAt,
    ),
  ]);

  for (const databaseId of Object.values(D1_DATABASE_IDS)) {
    if (!databaseNames.has(databaseId)) {
      throw new Error(`cloudflare_d1_database_missing:${databaseId}`);
    }
  }
  for (const databaseId of analytics.databaseIds) {
    if (!databaseNames.has(databaseId)) {
      databaseNames.set(databaseId, `unknown-${databaseId.slice(0, 12)}`);
    }
  }

  const databases = [...databaseNames.entries()]
    .map(([databaseId, databaseName]) => ({
      databaseId,
      databaseName,
      rowsReadObserved: analytics.databaseUsage.get(databaseId)?.rowsRead ?? 0,
      rowsWrittenObserved: analytics.databaseUsage.get(databaseId)?.rowsWritten ?? 0,
      storageBytesObserved: analytics.databaseStorage.get(databaseId) ?? 0,
    }))
    .sort((left, right) => left.databaseId.localeCompare(right.databaseId));

  return {
    version: 2,
    source: "cloudflare-paid-account-analytics-v2",
    accountId: input.accountId,
    capturedAt,
    plan,
    daily: analytics.daily.sort((left, right) => left.date.localeCompare(right.date)),
    databases,
    workers: [...analytics.workerUsage.values()].sort((left, right) =>
      left.scriptName.localeCompare(right.scriptName),
    ),
    workerRuntime: {
      startedAt: runtimeStartedAt,
      endedAt: runtimeEndedAt,
      workers: [...analytics.runtimeWorkerUsage.values()].sort((left, right) =>
        left.scriptName.localeCompare(right.scriptName),
      ),
    },
  };
}

function assertCloudflarePaidUsageInput(input: CloudflarePaidUsageInput) {
  if (!/^[0-9a-f]{32}$/.test(input.accountId)) throw new Error("cloudflare_account_id_invalid");
  if (!input.analyticsToken) throw new Error("cloudflare_analytics_token_missing");
  if (!input.billingToken) throw new Error("cloudflare_billing_token_missing");
  assertWorkerRuntimeWindowPair(input.runtimeStartedAt, input.runtimeEndedAt);
}

export const fetchD1UsageSnapshot = fetchCloudflarePaidUsageSnapshot;

export function evaluateD1PreflightBudget(
  snapshot: CloudflarePaidUsageSnapshot,
): D1BudgetEvaluation {
  assertSnapshot(snapshot);
  return evaluate(snapshot, null);
}

export function evaluateD1CanaryBudget(
  baseline: CloudflarePaidUsageSnapshot,
  current: CloudflarePaidUsageSnapshot,
): D1BudgetEvaluation {
  assertComparableSnapshots(baseline, current);
  const durationMinutes = elapsedMinutes(baseline.capturedAt, current.capturedAt);
  if (durationMinutes < CLOUDFLARE_PAID_THRESHOLDS.burnInMinutes) {
    return failedEvaluation(current, "cloudflare_paid_burn_in_too_short");
  }
  if (durationMinutes > 6 * 60) {
    return failedEvaluation(current, "cloudflare_paid_recent_window_too_long");
  }
  return evaluate(current, baseline);
}

export function evaluateD1RuntimeBudget(
  previousEvidence: D1QuotaEvidence,
  current: CloudflarePaidUsageSnapshot,
): D1BudgetEvaluation {
  const evidence = assertD1QuotaEvidence(previousEvidence);
  assertSnapshot(current);
  if (
    evidence.plan.periodStart !== current.plan.periodStart ||
    evidence.plan.periodEnd !== current.plan.periodEnd
  ) {
    return failedEvaluation(current, "cloudflare_paid_billing_period_changed");
  }
  const durationMinutes = elapsedMinutes(evidence.observedAt, current.capturedAt);
  if (durationMinutes < CLOUDFLARE_PAID_THRESHOLDS.burnInMinutes) {
    return failedEvaluation(current, "cloudflare_paid_runtime_window_too_short");
  }
  if (durationMinutes > 6 * 60) {
    return failedEvaluation(current, "cloudflare_paid_runtime_window_too_long");
  }
  const baseline = snapshotFromEvidence(evidence, current.accountId);
  return evaluate(current, baseline);
}

export function nearestRankP95(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function evaluate(
  current: CloudflarePaidUsageSnapshot,
  baseline: CloudflarePaidUsageSnapshot | null,
): D1BudgetEvaluation {
  assertSnapshot(current);
  const observed = usageTotals(current);
  const projected = projectedTotals(current, baseline, observed);
  const metricEvidence = buildMetricEvidence(observed, projected);
  const governing = [...metricEvidence].sort(
    (left, right) =>
      Math.max(right.currentPercent, right.projectedPercent) -
        Math.max(left.currentPercent, left.projectedPercent) ||
      left.metric.localeCompare(right.metric),
  )[0];
  if (!governing) throw new Error("cloudflare_paid_governing_metric_missing");
  const currentPercent = Math.max(...metricEvidence.map((metric) => metric.currentPercent));
  const projectedPercent = Math.max(...metricEvidence.map((metric) => metric.projectedPercent));
  const action = quotaActionForPercent(Math.max(currentPercent, projectedPercent));
  const reasons = action === "normal" ? [] : [`cloudflare_paid_quota_${action}`];
  const evidence = assertD1QuotaEvidence({
    version: 2,
    source: "cloudflare-paid-account-analytics-v2",
    observedAt: current.capturedAt,
    plan: {
      id: "workers-paid",
      verified: true,
      state: "Paid",
      frequency: "monthly",
      periodStart: current.plan.periodStart,
      periodEnd: current.plan.periodEnd,
    },
    limits: CLOUDFLARE_PAID_INCLUDED_LIMITS,
    thresholds: CLOUDFLARE_PAID_THRESHOLDS,
    usage: observed,
    projectedUsage: projected,
    metrics: metricEvidence,
    utilization: {
      currentPercent,
      projectedPercent,
      governingMetric: governing.metric,
    },
    action,
    databases: current.databases,
    workers: current.workers,
    workerRuntime: current.workerRuntime,
    passed: action === "normal",
  });

  return {
    version: 2,
    passed: action === "normal",
    action,
    reasons,
    evidence,
    metrics: {
      currentPercent,
      projectedPercent,
      governingMetric: governing.metric,
      workerRequestsProjected: projected.workerRequests,
      workerCpuMsProjected: projected.workerCpuMs,
      d1RowsReadProjected: projected.d1RowsRead,
      d1RowsWrittenProjected: projected.d1RowsWritten,
      d1StorageBytesProjected: projected.d1StorageBytes,
    },
  };
}

function projectedTotals(
  current: CloudflarePaidUsageSnapshot,
  baseline: CloudflarePaidUsageSnapshot | null,
  observed: UsageTotals,
): UsageTotals {
  const nowMs = Date.parse(current.capturedAt);
  const periodStartMs = Date.parse(current.plan.periodStart);
  const periodEndMs = Date.parse(current.plan.periodEnd);
  const remainingDays = Math.max(0, (periodEndMs - nowMs) / DAY_MS);
  const elapsedDays = Math.max(1 / 48, (nowMs - periodStartMs) / DAY_MS);
  const dailyP95 = {
    workerRequests: nearestRankP95(current.daily.map((day) => day.workerRequests)),
    workerCpuMs: nearestRankP95(current.daily.map((day) => day.workerCpuMs)),
    d1RowsRead: nearestRankP95(current.daily.map((day) => day.d1RowsRead)),
    d1RowsWritten: nearestRankP95(current.daily.map((day) => day.d1RowsWritten)),
  };
  const recent = baseline ? recentDailyRates(baseline, current) : null;

  return {
    workerRequests: projectCumulative(
      observed.workerRequests,
      dailyP95.workerRequests,
      recent?.workerRequests ?? 0,
      elapsedDays,
      remainingDays,
    ),
    workerCpuMs: projectCumulative(
      observed.workerCpuMs,
      dailyP95.workerCpuMs,
      recent?.workerCpuMs ?? 0,
      elapsedDays,
      remainingDays,
    ),
    d1RowsRead: projectCumulative(
      observed.d1RowsRead,
      dailyP95.d1RowsRead,
      recent?.d1RowsRead ?? 0,
      elapsedDays,
      remainingDays,
    ),
    d1RowsWritten: projectCumulative(
      observed.d1RowsWritten,
      dailyP95.d1RowsWritten,
      recent?.d1RowsWritten ?? 0,
      elapsedDays,
      remainingDays,
    ),
    d1StorageBytes: projectStorage(
      observed.d1StorageBytes,
      recent?.d1StorageBytes ?? 0,
      remainingDays,
    ),
  };
}

function projectCumulative(
  observed: number,
  p95Daily: number,
  recentDaily: number,
  elapsedDays: number,
  remainingDays: number,
) {
  const observedDaily = observed / elapsedDays;
  const governingDaily = Math.max(p95Daily, recentDaily, observedDaily);
  return safeInteger(
    observed + governingDaily * remainingDays * CLOUDFLARE_PAID_THRESHOLDS.safetyFactor,
  );
}

function projectStorage(observed: number, recentDailyGrowth: number, remainingDays: number) {
  return safeInteger(
    Math.max(
      observed,
      observed * CLOUDFLARE_PAID_THRESHOLDS.safetyFactor,
      observed + recentDailyGrowth * remainingDays * CLOUDFLARE_PAID_THRESHOLDS.safetyFactor,
    ),
  );
}

function recentDailyRates(
  baseline: CloudflarePaidUsageSnapshot,
  current: CloudflarePaidUsageSnapshot,
): UsageTotals {
  const minutes = elapsedMinutes(baseline.capturedAt, current.capturedAt);
  const multiplier = (24 * 60) / minutes;
  const before = usageTotals(baseline);
  const after = usageTotals(current);
  const delta = (field: keyof UsageTotals) => {
    const value = after[field] - before[field];
    if (value < 0) throw new Error(`cloudflare_paid_counter_regression:${field}`);
    return safeInteger(value * multiplier);
  };
  return {
    workerRequests: delta("workerRequests"),
    workerCpuMs: delta("workerCpuMs"),
    d1RowsRead: delta("d1RowsRead"),
    d1RowsWritten: delta("d1RowsWritten"),
    d1StorageBytes: delta("d1StorageBytes"),
  };
}

function usageTotals(snapshot: CloudflarePaidUsageSnapshot): UsageTotals {
  return {
    workerRequests: sum(snapshot.workers, "requestsObserved"),
    workerCpuMs: sum(snapshot.workers, "cpuMsObserved"),
    d1RowsRead: sum(snapshot.databases, "rowsReadObserved"),
    d1RowsWritten: sum(snapshot.databases, "rowsWrittenObserved"),
    d1StorageBytes: sum(snapshot.databases, "storageBytesObserved"),
  };
}

function snapshotFromEvidence(
  evidence: D1QuotaEvidence,
  accountId: string,
): CloudflarePaidUsageSnapshot {
  return {
    version: 2,
    source: "cloudflare-paid-account-analytics-v2",
    accountId,
    capturedAt: evidence.observedAt,
    plan: {
      ...evidence.plan,
      subscriptionId: "evidence",
      ratePlanId: "evidence",
    },
    daily: [],
    databases: evidence.databases,
    workers: evidence.workers,
    workerRuntime: evidence.workerRuntime,
  };
}

function failedEvaluation(
  snapshot: CloudflarePaidUsageSnapshot,
  reason: string,
): D1BudgetEvaluation {
  const usage = usageTotals(snapshot);
  const metricEvidence = buildMetricEvidence(usage, usage);
  const governing = [...metricEvidence].sort(
    (left, right) =>
      right.currentPercent - left.currentPercent || left.metric.localeCompare(right.metric),
  )[0];
  if (!governing) throw new Error("cloudflare_paid_governing_metric_missing");
  const currentPercent = Math.max(...metricEvidence.map((metric) => metric.currentPercent));
  return {
    version: 2,
    passed: false,
    action: "hard_stop",
    reasons: [reason],
    evidence: null,
    metrics: {
      currentPercent,
      projectedPercent: currentPercent,
      governingMetric: governing.metric,
      workerRequestsProjected: usage.workerRequests,
      workerCpuMsProjected: usage.workerCpuMs,
      d1RowsReadProjected: usage.d1RowsRead,
      d1RowsWrittenProjected: usage.d1RowsWritten,
      d1StorageBytesProjected: usage.d1StorageBytes,
    },
  };
}

function assertSnapshot(snapshot: CloudflarePaidUsageSnapshot) {
  assertSnapshotIdentity(snapshot);
  const { capturedAt, periodStart } = assertSnapshotPlan(snapshot);
  assertSnapshotDatabaseCount(snapshot);
  assertSnapshotMetrics(snapshot);
  assertSnapshotRuntimeWindow(snapshot, periodStart, capturedAt);
}

function assertSnapshotIdentity(snapshot: CloudflarePaidUsageSnapshot) {
  if (snapshot.version !== 2 || snapshot.source !== "cloudflare-paid-account-analytics-v2") {
    throw new Error("cloudflare_paid_snapshot_version_invalid");
  }
  if (!/^[0-9a-f]{32}$/.test(snapshot.accountId)) {
    throw new Error("cloudflare_paid_snapshot_account_invalid");
  }
}

function assertSnapshotPlan(snapshot: CloudflarePaidUsageSnapshot) {
  const capturedAt = Date.parse(snapshot.capturedAt);
  const periodStart = Date.parse(snapshot.plan.periodStart);
  const periodEnd = Date.parse(snapshot.plan.periodEnd);
  if (
    snapshot.plan.verified !== true ||
    snapshot.plan.state !== "Paid" ||
    snapshot.plan.frequency !== "monthly" ||
    !(periodStart < periodEnd && periodStart <= capturedAt && capturedAt < periodEnd)
  ) {
    throw new Error("cloudflare_paid_snapshot_plan_invalid");
  }
  return { capturedAt, periodStart };
}

function assertSnapshotDatabaseCount(snapshot: CloudflarePaidUsageSnapshot) {
  if (snapshot.databases.length < Object.keys(D1_DATABASE_IDS).length) {
    throw new Error("cloudflare_paid_snapshot_database_count_invalid");
  }
}

function assertSnapshotMetrics(snapshot: CloudflarePaidUsageSnapshot) {
  for (const value of [
    ...snapshot.daily.flatMap((entry) => [
      entry.workerRequests,
      entry.workerCpuMs,
      entry.d1RowsRead,
      entry.d1RowsWritten,
    ]),
    ...snapshot.databases.flatMap((entry) => [
      entry.rowsReadObserved,
      entry.rowsWrittenObserved,
      entry.storageBytesObserved,
    ]),
    ...snapshot.workers.flatMap((entry) => [
      entry.requestsObserved,
      entry.cpuMsObserved,
      entry.errorsObserved,
      entry.exceededCpuObserved,
      entry.cpuTimeAverageMs,
      entry.cpuTimeP95Ms,
      entry.cpuTimeP99Ms,
    ]),
    ...snapshot.workerRuntime.workers.flatMap((entry) => [
      entry.requestsObserved,
      entry.cpuMsObserved,
      entry.errorsObserved,
      entry.exceededCpuObserved,
      entry.cpuTimeAverageMs,
      entry.cpuTimeP95Ms,
      entry.cpuTimeP99Ms,
    ]),
  ]) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error("cloudflare_paid_snapshot_metric_invalid");
  }
}

function assertSnapshotRuntimeWindow(
  snapshot: CloudflarePaidUsageSnapshot,
  periodStart: number,
  capturedAt: number,
) {
  const runtimeStart = Date.parse(snapshot.workerRuntime.startedAt);
  const runtimeEnd = Date.parse(snapshot.workerRuntime.endedAt);
  if (
    !Number.isFinite(runtimeStart) ||
    !Number.isFinite(runtimeEnd) ||
    runtimeStart >= runtimeEnd ||
    runtimeEnd > capturedAt ||
    runtimeEnd - runtimeStart > WORKER_RUNTIME_WINDOW_MS ||
    runtimeStart < periodStart
  ) {
    throw new Error("cloudflare_paid_worker_runtime_window_invalid");
  }
}

function assertComparableSnapshots(
  baseline: CloudflarePaidUsageSnapshot,
  current: CloudflarePaidUsageSnapshot,
) {
  assertSnapshot(baseline);
  assertSnapshot(current);
  if (baseline.accountId !== current.accountId) throw new Error("cloudflare_paid_account_mismatch");
  if (
    baseline.plan.periodStart !== current.plan.periodStart ||
    baseline.plan.periodEnd !== current.plan.periodEnd
  ) {
    throw new Error("cloudflare_paid_billing_period_changed");
  }
  if (Date.parse(baseline.capturedAt) >= Date.parse(current.capturedAt)) {
    throw new Error("cloudflare_paid_snapshot_order_invalid");
  }
}

async function fetchPaidPlan(
  fetchImpl: typeof fetch,
  accountId: string,
  token: string,
  nowMs: number,
): Promise<CloudflarePaidPlan> {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/subscriptions`,
    {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`cloudflare_subscription_http_${response.status}`);
  const body = await readCloudflareJson(response);
  if (!isRecord(body) || body["success"] !== true || !Array.isArray(body["result"])) {
    throw new Error("cloudflare_subscription_schema_invalid");
  }
  const paid = body["result"].filter(isWorkersPaidSubscription);
  if (paid.length !== 1)
    throw new Error(`cloudflare_workers_paid_subscription_count:${paid.length}`);
  const subscription = paid[0];
  if (!subscription) throw new Error("cloudflare_workers_paid_subscription_missing");
  const ratePlan = subscription["rate_plan"];
  if (!isRecord(ratePlan)) throw new Error("cloudflare_workers_paid_rate_plan_missing");
  const periodStart = requiredTimestamp(subscription["current_period_start"]);
  const periodEnd = requiredTimestamp(subscription["current_period_end"]);
  if (!(Date.parse(periodStart) <= nowMs && nowMs < Date.parse(periodEnd))) {
    throw new Error("cloudflare_workers_paid_period_invalid");
  }
  return {
    id: "workers-paid",
    verified: true,
    state: "Paid",
    frequency: "monthly",
    periodStart,
    periodEnd,
    subscriptionId: requiredString(subscription["id"]),
    ratePlanId: requiredString(ratePlan["id"]),
  };
}

function isWorkersPaidSubscription(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value["state"] !== "Paid" || value["frequency"] !== "monthly") {
    return false;
  }
  const ratePlan = value["rate_plan"];
  if (!isRecord(ratePlan)) return false;
  return normalizeRatePlanId(ratePlan["id"]) === "workers_paid";
}

function normalizeRatePlanId(value: unknown) {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
    : "";
}

async function queryAccountAnalytics(
  fetchImpl: typeof fetch,
  accountId: string,
  token: string,
  startDate: string,
  endDate: string,
  startTimestamp: string,
  endTimestamp: string,
  runtimeStartTimestamp: string,
  runtimeEndTimestamp: string,
) {
  const response = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      query: CLOUDFLARE_PAID_USAGE_QUERY,
      variables: {
        accountTag: accountId,
        startDate,
        endDate,
        startTimestamp,
        endTimestamp,
        runtimeStartTimestamp,
        runtimeEndTimestamp,
      },
    }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`cloudflare_paid_graphql_http_${response.status}`);
  const body = await readCloudflareJson(response);
  if (!isRecord(body) || (Array.isArray(body["errors"]) && body["errors"].length > 0)) {
    throw new Error("cloudflare_paid_graphql_error");
  }
  const viewer = isRecord(body["data"]) ? body["data"]["viewer"] : null;
  const accounts = isRecord(viewer) ? viewer["accounts"] : null;
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    throw new Error("cloudflare_paid_graphql_account_count_invalid");
  }
  const account = accounts[0];
  if (!isRecord(account)) throw new Error("cloudflare_paid_graphql_account_missing");

  const d1Groups = requiredArray(account["d1AnalyticsAdaptiveGroups"], "d1_groups");
  const storageGroups = requiredArray(account["d1StorageAdaptiveGroups"], "d1_storage_groups");
  const workerGroups = requiredArray(account["workersInvocationsAdaptive"], "worker_groups");
  const runtimeWorkerGroups = requiredArray(account["workerRuntime"], "worker_runtime_groups");

  assertGraphqlGroupLimit(d1Groups, "d1_groups");
  assertGraphqlGroupLimit(storageGroups, "d1_storage_groups");
  assertGraphqlGroupLimit(workerGroups, "worker_groups");
  assertGraphqlGroupLimit(runtimeWorkerGroups, "worker_runtime_groups");

  return aggregateAnalyticsGroups(d1Groups, storageGroups, workerGroups, runtimeWorkerGroups);
}

function aggregateAnalyticsGroups(
  d1Groups: unknown[],
  storageGroups: unknown[],
  workerGroups: unknown[],
  runtimeWorkerGroups: unknown[],
) {
  const daily = new Map<string, AccountDailyUsage>();
  const databaseIds = new Set<string>();
  const databaseUsage = aggregateD1Usage(d1Groups, daily, databaseIds);
  const databaseStorage = aggregateD1Storage(storageGroups, databaseIds);
  const workerUsage = aggregateWorkerUsage(workerGroups, daily);
  const runtimeWorkerUsage = aggregateWorkerUsage(runtimeWorkerGroups);

  return {
    databaseIds,
    databaseUsage,
    databaseStorage,
    workerUsage,
    runtimeWorkerUsage,
    daily: [...daily.values()],
  };
}

function aggregateD1Usage(
  groups: unknown[],
  daily: Map<string, AccountDailyUsage>,
  databaseIds: Set<string>,
) {
  const databaseUsage = new Map<string, { rowsRead: number; rowsWritten: number }>();
  for (const group of groups) {
    const dimensions = nestedRecord(group, "dimensions", "d1_dimensions");
    const sums = nestedRecord(group, "sum", "d1_sum");
    const date = requiredString(dimensions["date"]);
    const databaseId = requiredString(dimensions["databaseId"]);
    const rowsRead = requiredCount(sums["rowsRead"]);
    const rowsWritten = requiredCount(sums["rowsWritten"]);
    databaseIds.add(databaseId);
    const aggregate = databaseUsage.get(databaseId) ?? { rowsRead: 0, rowsWritten: 0 };
    aggregate.rowsRead += rowsRead;
    aggregate.rowsWritten += rowsWritten;
    databaseUsage.set(databaseId, aggregate);
    const day = daily.get(date) ?? emptyDaily(date);
    day.d1RowsRead += rowsRead;
    day.d1RowsWritten += rowsWritten;
    daily.set(date, day);
  }
  return databaseUsage;
}

function aggregateD1Storage(groups: unknown[], databaseIds: Set<string>) {
  const databaseStorage = new Map<string, number>();
  for (const group of groups) {
    const dimensions = nestedRecord(group, "dimensions", "d1_storage_dimensions");
    const maximum = nestedRecord(group, "max", "d1_storage_max");
    const databaseId = requiredString(dimensions["databaseId"]);
    const storage = requiredCount(maximum["databaseSizeBytes"]);
    databaseIds.add(databaseId);
    databaseStorage.set(databaseId, Math.max(databaseStorage.get(databaseId) ?? 0, storage));
  }
  return databaseStorage;
}

function aggregateWorkerUsage(groups: unknown[], daily?: Map<string, AccountDailyUsage>) {
  const workerUsage = new Map<string, WorkerUsage>();
  for (const group of groups) {
    const dimensions = nestedRecord(group, "dimensions", "worker_dimensions");
    const sums = nestedRecord(group, "sum", "worker_sum");
    const quantiles = nestedRecord(group, "quantiles", "worker_quantiles");
    const date = requiredString(dimensions["date"]);
    const scriptName = requiredString(dimensions["scriptName"]);
    const status = requiredString(dimensions["status"]);
    const requests = requiredCount(sums["requests"]);
    const errors = requiredCount(sums["errors"]);
    const cpuMs = safeInteger(requiredCount(sums["cpuTimeUs"]) / 1_000);
    const cpuTimeP95Ms = requiredFinite(quantiles["cpuTimeP95"]) / 1_000;
    const cpuTimeP99Ms = requiredFinite(quantiles["cpuTimeP99"]) / 1_000;
    const aggregate = workerUsage.get(scriptName) ?? emptyWorkerUsage(scriptName);
    aggregate.requestsObserved += requests;
    aggregate.cpuMsObserved += cpuMs;
    aggregate.errorsObserved += errors;
    if (status === "exceededCpu") aggregate.exceededCpuObserved += requests;
    aggregate.cpuTimeAverageMs =
      aggregate.requestsObserved > 0 ? aggregate.cpuMsObserved / aggregate.requestsObserved : 0;
    aggregate.cpuTimeP95Ms = Math.max(aggregate.cpuTimeP95Ms, cpuTimeP95Ms);
    aggregate.cpuTimeP99Ms = Math.max(aggregate.cpuTimeP99Ms, cpuTimeP99Ms);
    workerUsage.set(scriptName, aggregate);
    if (daily) {
      const day = daily.get(date) ?? emptyDaily(date);
      day.workerRequests += requests;
      day.workerCpuMs += cpuMs;
      daily.set(date, day);
    }
  }
  return workerUsage;
}

function emptyWorkerUsage(scriptName: string): WorkerUsage {
  return {
    scriptName,
    requestsObserved: 0,
    cpuMsObserved: 0,
    errorsObserved: 0,
    exceededCpuObserved: 0,
    cpuTimeAverageMs: 0,
    cpuTimeP95Ms: 0,
    cpuTimeP99Ms: 0,
  };
}

function assertGraphqlGroupLimit(groups: unknown[], name: string) {
  if (groups.length >= GRAPHQL_GROUP_LIMIT) {
    throw new Error(`cloudflare_paid_graphql_${name}_limit_reached`);
  }
}

function emptyDaily(date: string): AccountDailyUsage {
  return { date, workerRequests: 0, workerCpuMs: 0, d1RowsRead: 0, d1RowsWritten: 0 };
}

function elapsedMinutes(start: string, end: string) {
  const minutes = (Date.parse(end) - Date.parse(start)) / 60_000;
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("cloudflare_paid_time_invalid");
  return minutes;
}

function sum<T>(items: T[], field: keyof T) {
  return safeInteger(
    items.reduce((total, item) => {
      const value = item[field];
      if (typeof value !== "number") throw new Error("cloudflare_paid_sum_field_invalid");
      return total + value;
    }, 0),
  );
}

function safeInteger(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error("cloudflare_paid_metric_out_of_range");
  }
  return Math.ceil(value);
}

function utcDate(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function requiredArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`cloudflare_paid_graphql_${name}_invalid`);
  return value;
}

function nestedRecord(value: unknown, field: string, name: string) {
  if (!isRecord(value) || !isRecord(value[field])) {
    throw new Error(`cloudflare_paid_graphql_${name}_invalid`);
  }
  return value[field];
}

function requiredString(value: unknown) {
  if (typeof value !== "string" || value.length === 0) throw new Error("cloudflare_string_invalid");
  return value;
}

function requiredTimestamp(value: unknown) {
  const timestamp = requiredString(value);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error("cloudflare_timestamp_invalid");
  return new Date(Date.parse(timestamp)).toISOString();
}

function requiredFinite(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("cloudflare_metric_invalid");
  }
  return value;
}

function requiredCount(value: unknown) {
  return safeInteger(requiredFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
