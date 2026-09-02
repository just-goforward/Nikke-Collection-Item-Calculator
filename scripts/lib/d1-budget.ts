import {
  assertD1QuotaEvidence,
  D1_CANARY_THRESHOLDS,
  D1_DATABASE_IDS,
  D1_FREE_LIMITS,
  type D1DatabaseEvidence,
  type D1QuotaEvidence,
} from "../../shared/d1QuotaEvidence.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const SAFETY_FACTOR = 2;

export type D1DailyUsage = {
  date: string;
  rowsRead: number;
  rowsWritten: number;
};

export type D1UsageDatabase = {
  databaseId: string;
  databaseName: string;
  role: D1DatabaseEvidence["role"];
  daily: D1DailyUsage[];
};

export type D1UsageSnapshot = {
  version: 1;
  source: "cloudflare-graphql-d1-analytics-v1";
  accountId: string;
  capturedAt: string;
  billingDay: string;
  databases: D1UsageDatabase[];
};

export type D1BudgetEvaluation = {
  version: 1;
  passed: boolean;
  reasons: string[];
  evidence: D1QuotaEvidence | null;
  metrics: {
    accountRowsReadProjected: number;
    accountRowsWrittenProjected: number;
    canaryRowsReadProjected: number;
    canaryRowsWrittenProjected: number;
  } | null;
};

export async function fetchD1UsageSnapshot(input: {
  accountId: string;
  token: string;
  nowMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<D1UsageSnapshot> {
  if (!/^[0-9a-f]{32}$/.test(input.accountId)) throw new Error("cloudflare_account_id_invalid");
  if (!input.token) throw new Error("cloudflare_analytics_token_missing");
  const fetchImpl = input.fetchImpl ?? fetch;
  const nowMs = input.nowMs ?? Date.now();
  const billingDay = utcDate(nowMs);
  const start = utcDate(nowMs - 7 * DAY_MS);
  const [databaseNames, groups] = await Promise.all([
    listDatabases(fetchImpl, input.accountId, input.token),
    queryDailyUsage(fetchImpl, input.accountId, input.token, start, billingDay),
  ]);
  for (const databaseId of Object.values(D1_DATABASE_IDS)) {
    if (!databaseNames.has(databaseId))
      throw new Error(`cloudflare_d1_database_missing:${databaseId}`);
  }
  for (const group of groups) {
    if (!databaseNames.has(group.databaseId)) {
      databaseNames.set(group.databaseId, `unknown-${group.databaseId.slice(0, 12)}`);
    }
  }
  return {
    version: 1,
    source: "cloudflare-graphql-d1-analytics-v1",
    accountId: input.accountId,
    capturedAt: new Date(nowMs).toISOString(),
    billingDay,
    databases: [...databaseNames.entries()]
      .map(([databaseId, databaseName]) => ({
        databaseId,
        databaseName,
        role: databaseRole(databaseId),
        daily: groups
          .filter((group) => group.databaseId === databaseId)
          .sort((left, right) => left.date.localeCompare(right.date)),
      }))
      .sort((left, right) => left.databaseId.localeCompare(right.databaseId)),
  };
}

export function evaluateD1CanaryBudget(
  baseline: D1UsageSnapshot,
  current: D1UsageSnapshot,
): D1BudgetEvaluation {
  assertComparableSnapshots(baseline, current);
  const startedAt = Date.parse(baseline.capturedAt);
  const endedAt = Date.parse(current.capturedAt);
  const durationMinutes = (endedAt - startedAt) / 60_000;
  if (durationMinutes < D1_CANARY_THRESHOLDS.burnInMinutes) {
    return failure("d1_budget_burn_in_too_short");
  }
  if (durationMinutes > 90) return failure("d1_budget_burn_in_too_long");

  const projectionMinutes = minutesUntilD1Reset(startedAt);
  const canaryProjectionMinutes = minutesUntilD1Reset(endedAt);
  const forecastRates = forecastAutomationRates(
    baseline,
    current,
    durationMinutes,
    projectionMinutes,
  );
  if (!forecastRates) return failure("d1_budget_counter_regression");
  const canaryRate = forecastRates.get(D1_DATABASE_IDS.forecastStaging);
  if (!canaryRate) return failure("d1_budget_canary_database_missing");
  const burnInReads = canaryRate.deltaReads;
  const burnInWrites = canaryRate.deltaWrites;
  if (burnInReads === 0 || burnInWrites === 0) {
    return failure("d1_budget_burn_in_metrics_missing");
  }

  const canaryProjectedReads = projectRate(burnInReads, durationMinutes, canaryProjectionMinutes);
  const canaryProjectedWrites = projectRate(burnInWrites, durationMinutes, canaryProjectionMinutes);
  const remainingFraction = remainingBillingDayFraction(endedAt);
  const databases = current.databases.map((database) => {
    const today = dailyUsage(database, current.billingDay);
    const history = database.daily.filter((entry) => entry.date !== current.billingDay);
    const rowsReadP95 = nearestRankP95(history.map((entry) => entry.rowsRead));
    const rowsWrittenP95 = nearestRankP95(history.map((entry) => entry.rowsWritten));
    const forecastRate = forecastRates.get(database.databaseId);
    return {
      databaseId: database.databaseId,
      databaseName: database.databaseName,
      role: database.role,
      rowsReadObserved: today.rowsRead,
      rowsWrittenObserved: today.rowsWritten,
      rowsReadP95,
      rowsWrittenP95,
      rowsReadProjected: forecastRate
        ? forecastRate.baselineReads + forecastRate.projectedReads
        : today.rowsRead + Math.ceil(rowsReadP95 * remainingFraction),
      rowsWrittenProjected: forecastRate
        ? forecastRate.baselineWrites + forecastRate.projectedWrites
        : today.rowsWritten + Math.ceil(rowsWrittenP95 * remainingFraction),
    } satisfies D1DatabaseEvidence;
  });
  const stats = databases.find(
    (database) => database.databaseId === D1_DATABASE_IDS.statsProduction,
  );
  if (!stats) return failure("d1_budget_stats_production_missing");
  const account = {
    rowsReadObserved: sum(databases, "rowsReadObserved"),
    rowsWrittenObserved: sum(databases, "rowsWrittenObserved"),
    rowsReadProjected: sum(databases, "rowsReadProjected"),
    rowsWrittenProjected: sum(databases, "rowsWrittenProjected"),
  };
  const evidence: D1QuotaEvidence = {
    version: 1,
    source: "cloudflare-graphql-d1-analytics-v1",
    billingDay: current.billingDay,
    observedAt: current.capturedAt,
    burnIn: {
      startedAt: baseline.capturedAt,
      endedAt: current.capturedAt,
      durationMinutes,
    },
    limits: D1_FREE_LIMITS,
    thresholds: D1_CANARY_THRESHOLDS,
    account,
    canary: {
      databaseId: D1_DATABASE_IDS.forecastStaging,
      rowsReadBurnIn: burnInReads,
      rowsWrittenBurnIn: burnInWrites,
      rowsReadProjected: canaryProjectedReads,
      rowsWrittenProjected: canaryProjectedWrites,
    },
    statsProduction: {
      databaseId: D1_DATABASE_IDS.statsProduction,
      rowsReadP95: stats.rowsReadP95,
      rowsWrittenP95: stats.rowsWrittenP95,
      rowsReadReserve: Math.max(
        D1_CANARY_THRESHOLDS.minimumStatsRowsReadReserve,
        stats.rowsReadP95 * D1_CANARY_THRESHOLDS.statsP95ReserveMultiplier,
      ),
      rowsWrittenReserve: Math.max(
        D1_CANARY_THRESHOLDS.minimumStatsRowsWrittenReserve,
        stats.rowsWrittenP95 * D1_CANARY_THRESHOLDS.statsP95ReserveMultiplier,
      ),
    },
    databases,
    passed: true,
  };
  const reasons = budgetFailureReasons(evidence);
  const metrics = evaluationMetrics(evidence);
  if (reasons.length > 0) return { version: 1, passed: false, reasons, evidence: null, metrics };
  assertD1QuotaEvidence(evidence);
  return { version: 1, passed: true, reasons: [], evidence, metrics };
}

export function evaluateD1PreflightBudget(snapshot: D1UsageSnapshot): D1BudgetEvaluation {
  const capturedAt = Date.parse(snapshot.capturedAt);
  const remainingFraction = remainingBillingDayFraction(capturedAt);
  const databases = snapshot.databases.map((database) => {
    const today = dailyUsage(database, snapshot.billingDay);
    const history = database.daily.filter((entry) => entry.date !== snapshot.billingDay);
    const rowsReadP95 = nearestRankP95(history.map((entry) => entry.rowsRead));
    const rowsWrittenP95 = nearestRankP95(history.map((entry) => entry.rowsWritten));
    const forecastAutomation = isForecastAutomationDatabase(database.databaseId);
    return {
      databaseId: database.databaseId,
      databaseName: database.databaseName,
      role: database.role,
      rowsReadObserved: today.rowsRead,
      rowsWrittenObserved: today.rowsWritten,
      rowsReadP95,
      rowsWrittenP95,
      rowsReadProjected:
        today.rowsRead +
        (forecastAutomation
          ? D1_CANARY_THRESHOLDS.maximumCanaryRowsRead
          : Math.ceil(rowsReadP95 * remainingFraction)),
      rowsWrittenProjected:
        today.rowsWritten +
        (forecastAutomation
          ? D1_CANARY_THRESHOLDS.maximumCanaryRowsWritten
          : Math.ceil(rowsWrittenP95 * remainingFraction)),
    } satisfies D1DatabaseEvidence;
  });
  const stats = databases.find(
    (database) => database.databaseId === D1_DATABASE_IDS.statsProduction,
  );
  if (!stats) return failure("d1_budget_stats_production_missing");
  const rowsReadProjected = sum(databases, "rowsReadProjected");
  const rowsWrittenProjected = sum(databases, "rowsWrittenProjected");
  const rowsReadReserve = Math.max(
    D1_CANARY_THRESHOLDS.minimumStatsRowsReadReserve,
    stats.rowsReadP95 * D1_CANARY_THRESHOLDS.statsP95ReserveMultiplier,
  );
  const rowsWrittenReserve = Math.max(
    D1_CANARY_THRESHOLDS.minimumStatsRowsWrittenReserve,
    stats.rowsWrittenP95 * D1_CANARY_THRESHOLDS.statsP95ReserveMultiplier,
  );
  const reasons = [
    rowsReadProjected > D1_CANARY_THRESHOLDS.maximumProjectedRowsRead
      ? "d1_budget_projected_reads_exceeded"
      : null,
    rowsWrittenProjected > D1_CANARY_THRESHOLDS.maximumProjectedRowsWritten
      ? "d1_budget_projected_writes_exceeded"
      : null,
    D1_FREE_LIMITS.rowsRead - rowsReadProjected < rowsReadReserve
      ? "d1_budget_stats_read_reserve_exhausted"
      : null,
    D1_FREE_LIMITS.rowsWritten - rowsWrittenProjected < rowsWrittenReserve
      ? "d1_budget_stats_write_reserve_exhausted"
      : null,
  ].filter((reason): reason is string => reason !== null);
  const metrics = {
    accountRowsReadProjected: rowsReadProjected,
    accountRowsWrittenProjected: rowsWrittenProjected,
    canaryRowsReadProjected: 0,
    canaryRowsWrittenProjected: 0,
  };
  return {
    version: 1,
    passed: reasons.length === 0,
    reasons,
    evidence: null,
    metrics,
  };
}

export function evaluateD1RuntimeBudget(
  initialEvidence: D1QuotaEvidence,
  current: D1UsageSnapshot,
): D1BudgetEvaluation {
  assertD1QuotaEvidence(initialEvidence);
  if (current.billingDay !== initialEvidence.billingDay) {
    return failure("d1_budget_billing_day_changed");
  }
  const startedAt = Date.parse(initialEvidence.observedAt);
  const nowMs = Date.parse(current.capturedAt);
  const elapsedMinutes = (nowMs - startedAt) / 60_000;
  if (elapsedMinutes <= 0) return failure("d1_budget_runtime_time_invalid");
  const projectionMinutes = minutesUntilD1Reset(startedAt);
  const forecastRates = runtimeForecastAutomationRates(
    initialEvidence,
    current,
    elapsedMinutes,
    projectionMinutes,
  );
  if (!forecastRates) return failure("d1_budget_counter_regression");
  const canaryRate = forecastRates.get(D1_DATABASE_IDS.forecastStaging);
  if (!canaryRate) return failure("d1_budget_canary_database_missing");
  const deltaReads = canaryRate.deltaReads;
  const deltaWrites = canaryRate.deltaWrites;
  const canaryProjectedReads = canaryRate.projectedReads;
  const canaryProjectedWrites = canaryRate.projectedWrites;
  const remainingFraction = remainingBillingDayFraction(nowMs);
  const databases = current.databases.map((database) => {
    const today = dailyUsage(database, current.billingDay);
    const history = database.daily.filter((entry) => entry.date !== current.billingDay);
    const rowsReadP95 = nearestRankP95(history.map((entry) => entry.rowsRead));
    const rowsWrittenP95 = nearestRankP95(history.map((entry) => entry.rowsWritten));
    const forecastRate = forecastRates.get(database.databaseId);
    return {
      databaseId: database.databaseId,
      databaseName: database.databaseName,
      role: database.role,
      rowsReadObserved: today.rowsRead,
      rowsWrittenObserved: today.rowsWritten,
      rowsReadP95,
      rowsWrittenP95,
      rowsReadProjected: forecastRate
        ? forecastRate.baselineReads + forecastRate.projectedReads
        : today.rowsRead + Math.ceil(rowsReadP95 * remainingFraction),
      rowsWrittenProjected: forecastRate
        ? forecastRate.baselineWrites + forecastRate.projectedWrites
        : today.rowsWritten + Math.ceil(rowsWrittenP95 * remainingFraction),
    } satisfies D1DatabaseEvidence;
  });
  const account = {
    rowsReadObserved: sum(databases, "rowsReadObserved"),
    rowsWrittenObserved: sum(databases, "rowsWrittenObserved"),
    rowsReadProjected: sum(databases, "rowsReadProjected"),
    rowsWrittenProjected: sum(databases, "rowsWrittenProjected"),
  };
  const evidence: D1QuotaEvidence = {
    ...initialEvidence,
    observedAt: current.capturedAt,
    account,
    canary: {
      ...initialEvidence.canary,
      rowsReadBurnIn: deltaReads,
      rowsWrittenBurnIn: deltaWrites,
      rowsReadProjected: canaryProjectedReads,
      rowsWrittenProjected: canaryProjectedWrites,
    },
    databases,
  };
  const reasons = budgetFailureReasons(evidence);
  return reasons.length === 0
    ? {
        version: 1,
        passed: true,
        reasons: [],
        evidence: initialEvidence,
        metrics: evaluationMetrics(evidence),
      }
    : { version: 1, passed: false, reasons, evidence: null, metrics: evaluationMetrics(evidence) };
}

export function nearestRankP95(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function budgetFailureReasons(evidence: D1QuotaEvidence) {
  const reasons = [
    evidence.account.rowsReadProjected > D1_CANARY_THRESHOLDS.maximumProjectedRowsRead
      ? "d1_budget_projected_reads_exceeded"
      : null,
    evidence.account.rowsWrittenProjected > D1_CANARY_THRESHOLDS.maximumProjectedRowsWritten
      ? "d1_budget_projected_writes_exceeded"
      : null,
    evidence.canary.rowsReadProjected > D1_CANARY_THRESHOLDS.maximumCanaryRowsRead
      ? "d1_budget_canary_reads_exceeded"
      : null,
    evidence.canary.rowsWrittenProjected > D1_CANARY_THRESHOLDS.maximumCanaryRowsWritten
      ? "d1_budget_canary_writes_exceeded"
      : null,
    D1_FREE_LIMITS.rowsRead - evidence.account.rowsReadProjected <
    evidence.statsProduction.rowsReadReserve
      ? "d1_budget_stats_read_reserve_exhausted"
      : null,
    D1_FREE_LIMITS.rowsWritten - evidence.account.rowsWrittenProjected <
    evidence.statsProduction.rowsWrittenReserve
      ? "d1_budget_stats_write_reserve_exhausted"
      : null,
  ];
  return reasons.filter((reason): reason is string => reason !== null);
}

function projectRate(delta: number, durationMinutes: number, projectionMinutes: number) {
  return Math.ceil((delta * projectionMinutes * SAFETY_FACTOR) / durationMinutes);
}

type ForecastAutomationRate = {
  baselineReads: number;
  baselineWrites: number;
  deltaReads: number;
  deltaWrites: number;
  projectedReads: number;
  projectedWrites: number;
};

function forecastAutomationRates(
  baseline: D1UsageSnapshot,
  current: D1UsageSnapshot,
  durationMinutes: number,
  projectionMinutes: number,
) {
  const rates = new Map<string, ForecastAutomationRate>();
  for (const databaseId of forecastAutomationDatabaseIds()) {
    const before = databaseToday(baseline, databaseId);
    const after = databaseToday(current, databaseId);
    const rate = forecastAutomationRate(
      before.rowsRead,
      before.rowsWritten,
      after.rowsRead,
      after.rowsWritten,
      durationMinutes,
      projectionMinutes,
    );
    if (!rate) return null;
    rates.set(databaseId, rate);
  }
  return rates;
}

function runtimeForecastAutomationRates(
  initialEvidence: D1QuotaEvidence,
  current: D1UsageSnapshot,
  durationMinutes: number,
  projectionMinutes: number,
) {
  const rates = new Map<string, ForecastAutomationRate>();
  for (const databaseId of forecastAutomationDatabaseIds()) {
    const before = initialEvidence.databases.find((database) => database.databaseId === databaseId);
    if (!before) return null;
    const after = databaseToday(current, databaseId);
    const rate = forecastAutomationRate(
      before.rowsReadObserved,
      before.rowsWrittenObserved,
      after.rowsRead,
      after.rowsWritten,
      durationMinutes,
      projectionMinutes,
    );
    if (!rate) return null;
    rates.set(databaseId, rate);
  }
  return rates;
}

function forecastAutomationRate(
  baselineReads: number,
  baselineWrites: number,
  currentReads: number,
  currentWrites: number,
  durationMinutes: number,
  projectionMinutes: number,
): ForecastAutomationRate | null {
  const deltaReads = currentReads - baselineReads;
  const deltaWrites = currentWrites - baselineWrites;
  if (deltaReads < 0 || deltaWrites < 0) return null;
  return {
    baselineReads,
    baselineWrites,
    deltaReads,
    deltaWrites,
    projectedReads: projectRate(deltaReads, durationMinutes, projectionMinutes),
    projectedWrites: projectRate(deltaWrites, durationMinutes, projectionMinutes),
  };
}

function forecastAutomationDatabaseIds() {
  return [D1_DATABASE_IDS.forecastProduction, D1_DATABASE_IDS.forecastStaging] as const;
}

function isForecastAutomationDatabase(databaseId: string) {
  return forecastAutomationDatabaseIds().includes(
    databaseId as ReturnType<typeof forecastAutomationDatabaseIds>[number],
  );
}

function assertComparableSnapshots(baseline: D1UsageSnapshot, current: D1UsageSnapshot) {
  if (baseline.version !== 1 || current.version !== 1) throw new Error("d1_budget_version_invalid");
  if (baseline.source !== current.source) throw new Error("d1_budget_source_mismatch");
  if (baseline.accountId !== current.accountId) throw new Error("d1_budget_account_mismatch");
  if (baseline.billingDay !== current.billingDay) throw new Error("d1_budget_billing_day_changed");
  const baselineIds = baseline.databases
    .map((database) => database.databaseId)
    .sort()
    .join(",");
  const currentIds = current.databases
    .map((database) => database.databaseId)
    .sort()
    .join(",");
  if (baselineIds !== currentIds) throw new Error("d1_budget_database_set_changed");
}

function databaseToday(snapshot: D1UsageSnapshot, databaseId: string) {
  const database = snapshot.databases.find((entry) => entry.databaseId === databaseId);
  if (!database) throw new Error(`d1_budget_database_missing:${databaseId}`);
  return dailyUsage(database, snapshot.billingDay);
}

function dailyUsage(database: D1UsageDatabase, date: string) {
  return (
    database.daily.find((entry) => entry.date === date) ?? {
      date,
      rowsRead: 0,
      rowsWritten: 0,
    }
  );
}

function remainingBillingDayFraction(nowMs: number) {
  return Math.max(0, Math.min(1, minutesUntilD1Reset(nowMs) / (24 * 60)));
}

function minutesUntilD1Reset(nowMs: number) {
  const nextMidnight = Date.parse(`${utcDate(nowMs + DAY_MS)}T00:00:00.000Z`);
  return (nextMidnight - nowMs) / 60_000;
}

function sum(
  databases: D1DatabaseEvidence[],
  field: "rowsReadObserved" | "rowsWrittenObserved" | "rowsReadProjected" | "rowsWrittenProjected",
) {
  return databases.reduce((total, database) => total + database[field], 0);
}

function failure(reason: string): D1BudgetEvaluation {
  return { version: 1, passed: false, reasons: [reason], evidence: null, metrics: null };
}

function evaluationMetrics(evidence: D1QuotaEvidence) {
  return {
    accountRowsReadProjected: evidence.account.rowsReadProjected,
    accountRowsWrittenProjected: evidence.account.rowsWrittenProjected,
    canaryRowsReadProjected: evidence.canary.rowsReadProjected,
    canaryRowsWrittenProjected: evidence.canary.rowsWrittenProjected,
  };
}

function utcDate(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function databaseRole(databaseId: string): D1DatabaseEvidence["role"] {
  if (databaseId === D1_DATABASE_IDS.statsProduction) return "stats-production";
  if (databaseId === D1_DATABASE_IDS.statsStaging) return "stats-staging";
  if (databaseId === D1_DATABASE_IDS.forecastProduction) return "forecast-production";
  if (databaseId === D1_DATABASE_IDS.forecastStaging) return "forecast-staging";
  return "other";
}

async function listDatabases(fetchImpl: typeof fetch, accountId: string, token: string) {
  const names = new Map<string, string>();
  for (let page = 1; page <= 10; page += 1) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`cloudflare_d1_list_http_${response.status}`);
    const body = (await response.json()) as unknown;
    if (!isRecord(body) || body["success"] !== true || !Array.isArray(body["result"])) {
      throw new Error("cloudflare_d1_list_schema_invalid");
    }
    for (const item of body["result"]) {
      if (!isRecord(item) || typeof item["uuid"] !== "string" || typeof item["name"] !== "string") {
        throw new Error("cloudflare_d1_list_item_invalid");
      }
      names.set(item["uuid"], item["name"]);
    }
    const info = body["result_info"];
    if (!isRecord(info) || typeof info["total_pages"] !== "number") break;
    if (page >= info["total_pages"]) break;
  }
  return names;
}

async function queryDailyUsage(
  fetchImpl: typeof fetch,
  accountId: string,
  token: string,
  start: string,
  end: string,
) {
  const response = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      query: `query D1Budget($accountTag: string!, $start: Date, $end: Date) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            d1AnalyticsAdaptiveGroups(
              limit: 10000
              filter: { date_geq: $start, date_leq: $end }
              orderBy: [date_DESC]
            ) {
              sum { rowsRead rowsWritten }
              dimensions { date databaseId }
            }
          }
        }
      }`,
      variables: { accountTag: accountId, start, end },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`cloudflare_d1_graphql_http_${response.status}`);
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || (Array.isArray(body["errors"]) && body["errors"].length > 0)) {
    throw new Error("cloudflare_d1_graphql_error");
  }
  const viewer = isRecord(body["data"]) ? body["data"]["viewer"] : null;
  const accounts = isRecord(viewer) ? viewer["accounts"] : null;
  const account = Array.isArray(accounts) ? accounts[0] : null;
  const groups = isRecord(account) ? account["d1AnalyticsAdaptiveGroups"] : null;
  if (!Array.isArray(groups)) throw new Error("cloudflare_d1_graphql_schema_invalid");
  return groups.map((group) => {
    if (!isRecord(group) || !isRecord(group["dimensions"]) || !isRecord(group["sum"])) {
      throw new Error("cloudflare_d1_graphql_group_invalid");
    }
    const date = group["dimensions"]["date"];
    const databaseId = group["dimensions"]["databaseId"];
    const rowsRead = group["sum"]["rowsRead"];
    const rowsWritten = group["sum"]["rowsWritten"];
    if (
      typeof date !== "string" ||
      typeof databaseId !== "string" ||
      !isNonNegativeNumber(rowsRead) ||
      !isNonNegativeNumber(rowsWritten)
    ) {
      throw new Error("cloudflare_d1_graphql_metric_invalid");
    }
    return {
      date,
      databaseId,
      rowsRead: Math.round(rowsRead),
      rowsWritten: Math.round(rowsWritten),
    };
  });
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
