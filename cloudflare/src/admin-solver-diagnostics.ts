import { SUPPLY_FORECAST_REGISTRY } from "../../shared/generated/supplyForecast";
import {
  CURRENT_STATISTICS_DATE_BASIS,
  kstDateKeyFromUnixSeconds,
  kstGameDateKeyFromUnixSeconds,
  LEGACY_STATISTICS_DATE_BASIS,
  STATISTICS_DATE_CONTRACT,
} from "./date-key";
import type { WorkerEnv } from "./env";
import { isAllowedOrigin, jsonResponse } from "./http";
import { HttpError } from "./http-error";

type SolverDiagnosticSummaryRow = {
  date_basis?: string | null;
  forecast_id?: string | null;
  solver_version?: string | null;
  solver_phase?: string | null;
  events?: number | string | null;
  first_date?: string | null;
  last_date?: string | null;
};

type SolverDiagnosticDailyRow = {
  date_basis?: string | null;
  date_key?: string | null;
  forecast_id?: string | null;
  solver_version?: string | null;
  solver_phase?: string | null;
  events?: number | string | null;
};

type SolverNodeCountRow = {
  date_basis?: string | null;
  forecast_id?: string | null;
  solver_backend?: string | null;
  node_count_bucket?: string | null;
  events?: number | string | null;
};

type SolverRuntimeRow = {
  date_basis?: string | null;
  forecast_id?: string | null;
  solver_version?: string | null;
  solver_phase?: string | null;
  solver_backend?: string | null;
  fallback_from?: string | null;
  fallback_reason?: string | null;
  memory_strategy?: string | null;
  min_ef_memo_tier?: string | null;
  phase2_memo_tier?: string | null;
  phase2_memo_retried?: string | null;
  grade?: string | null;
  level?: number | string | null;
  exp_bucket?: number | string | null;
  stock_bucket_blue?: string | null;
  stock_bucket_purple?: string | null;
  stock_bucket_yellow?: string | null;
  node_count_bucket?: string | null;
  attempted_node_count_bucket?: string | null;
  solve_ms_bucket?: string | null;
  events?: number | string | null;
};

type SolverCacheRow = {
  date_basis?: string | null;
  diagnostic_version?: number | string | null;
  forecast_id?: string | null;
  requested_backend?: string | null;
  terminal_backend?: string | null;
  execution_kind?: string | null;
  events?: number | string | null;
};

type CalculationLocaleRow = SolverCacheRow & {
  locale?: string | null;
};

type SolverRecoveryRungRow = {
  date_basis?: string | null;
  forecast_id?: string | null;
  policy_version?: string | null;
  requested_backend?: string | null;
  rung_backend?: string | null;
  rung_exit?: string | null;
  device_type?: string | null;
  events?: number | string | null;
};

type SolverRecoveryTerminalRow = {
  date_basis?: string | null;
  forecast_id?: string | null;
  policy_version?: string | null;
  requested_backend?: string | null;
  terminal_backend?: string | null;
  terminal_outcome?: string | null;
  events?: number | string | null;
};

type RuntimeInvariantRow = {
  date_basis?: string | null;
  invariant_version?: number | string | null;
  invariant_code?: string | null;
  component?: string | null;
  lane?: string | null;
  device_type?: string | null;
  events?: number | string | null;
  last_seen?: number | string | null;
};

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const TRUSTWORTHY_RUNTIME_DIAGNOSTIC_VERSION = 6;

type StatisticsWindow = {
  legacy: string;
  current: string;
};

type StatisticsAggregateTable =
  | "calculation_locale_aggregates"
  | "runtime_invariant_aggregates"
  | "solver_cache_aggregates"
  | "solver_diagnostic_aggregates"
  | "solver_recovery_rung_aggregates"
  | "solver_recovery_terminal_aggregates"
  | "solver_runtime_aggregates";

export async function handleAdminSolverDiagnostics(request: Request, env: WorkerEnv) {
  await assertAdminRequest(request, env);
  const now = Math.floor(Date.now() / 1000);
  const windowDays = readWindowDays(request);
  const sinceByDateBasis = {
    legacy: kstDateKeyFromUnixSeconds(now - 86400 * (windowDays - 1)),
    current: kstGameDateKeyFromUnixSeconds(now - 86400 * (windowDays - 1)),
  } satisfies StatisticsWindow;

  const results = await env.DB.batch([
    solverDiagnosticSummaryStatement(env),
    solverDiagnosticSummaryStatement(env, sinceByDateBasis),
    solverDiagnosticDailyStatement(env, sinceByDateBasis),
    solverNodeCountsStatement(env, sinceByDateBasis),
    solverRuntimeStatement(env, sinceByDateBasis),
    solverCacheStatement(env, sinceByDateBasis),
    calculationLocaleStatement(env, sinceByDateBasis),
    solverRecoveryRungStatement(env, sinceByDateBasis),
    solverRecoveryTerminalStatement(env, sinceByDateBasis),
    runtimeInvariantStatement(env, sinceByDateBasis),
  ]);
  const allTime = mapSolverDiagnosticSummary(resultAt(results, 0));
  const window = mapSolverDiagnosticSummary(resultAt(results, 1));
  const daily = mapSolverDiagnosticDaily(resultAt(results, 2));
  const nodeCounts = mapSolverNodeCounts(resultAt(results, 3));
  const runtime = mapSolverRuntime(resultAt(results, 4));
  const cache = mapSolverCache(resultAt(results, 5));
  const calculationLocales = mapCalculationLocales(resultAt(results, 6));
  const recoveryRungs = mapSolverRecoveryRungs(resultAt(results, 7));
  const recoveryTerminals = mapSolverRecoveryTerminals(resultAt(results, 8));
  const runtimeInvariants = mapRuntimeInvariants(resultAt(results, 9));

  return jsonResponse(request, env, {
    generatedAt: new Date(now * 1000).toISOString(),
    windowDays,
    since: sinceByDateBasis.current,
    sinceByDateBasis: {
      [LEGACY_STATISTICS_DATE_BASIS]: sinceByDateBasis.legacy,
      [CURRENT_STATISTICS_DATE_BASIS]: sinceByDateBasis.current,
    },
    dateContract: {
      legacy: STATISTICS_DATE_CONTRACT.legacy,
      current: STATISTICS_DATE_CONTRACT.current,
      rowsExposeDateBasis: true,
    },
    allTime,
    window,
    daily,
    nodeCounts,
    runtime,
    cache,
    calculationLocales,
    recoveryRungs,
    recoveryTerminals,
    runtimeInvariants,
    supplyForecastRegistry: SUPPLY_FORECAST_REGISTRY,
    fallbacks: summarizeFallbacks(runtime),
    latencies: summarizeLatencyBuckets(runtime),
    runtimeDataPolicy: {
      trustworthyFromDiagnosticVersion: TRUSTWORTHY_RUNTIME_DIAGNOSTIC_VERSION,
      filteredToTrustworthyVersions: true,
      legacyClassification: "usage_weighted_historical_snapshot",
      solveMsSemantics: "end_to_end_recovery_wall_time",
    },
    recoveryDataPolicy: {
      aggregatesAreIndependent: true,
      ratioWarning: "do_not_divide_terminal_counts_by_rung_counts",
    },
    runtimeInvariantDataPolicy: {
      bucketedOnly: true,
      rawErrorsStored: false,
    },
    localeDataPolicy: {
      source: "solver_diagnostic_at_calculation_time",
      missingLocaleEventsExcluded: true,
      supportedLocales: ["ko", "ja", "en"],
    },
  });
}

async function assertAdminRequest(request: Request, env: WorkerEnv) {
  if (!isAllowedOrigin(request, env)) throw new HttpError(403, "origin_not_allowed");
  if (!env.DB) throw new HttpError(500, "database_not_configured");
  if (!env.ADMIN_TOKEN) throw new HttpError(404, "not_found");
  if (!(await tokensMatch(bearerToken(request), env.ADMIN_TOKEN)))
    throw new HttpError(403, "admin_forbidden");
}

async function tokensMatch(provided: string, expected: string) {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === "function")
    return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
  return constantTimeEqual(providedHash, expectedHash);
}

function constantTimeEqual(left: ArrayBuffer, right: ArrayBuffer) {
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function bearerToken(request: Request) {
  const value = request.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() || "";
}

function readWindowDays(request: Request) {
  const value = Number(new URL(request.url).searchParams.get("days") || DEFAULT_WINDOW_DAYS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_WINDOW_DAYS;
  return Math.min(MAX_WINDOW_DAYS, Math.floor(value));
}

function resultAt(results: D1Result<unknown>[], index: number) {
  const result = results[index];
  if (!result) throw new HttpError(500, "diagnostic_query_incomplete");
  return result;
}

function statisticsAggregateSource(table: StatisticsAggregateTable) {
  return `(SELECT '${LEGACY_STATISTICS_DATE_BASIS}' AS date_basis, * FROM ${table}
    UNION ALL
    SELECT '${CURRENT_STATISTICS_DATE_BASIS}' AS date_basis, * FROM ${table}_game_day)`;
}

function statisticsWindowPredicate() {
  return `((date_basis = ? AND date_key >= ?) OR (date_basis = ? AND date_key >= ?))`;
}

function bindStatisticsWindow(
  statement: D1PreparedStatement,
  since: StatisticsWindow,
  ...additionalValues: unknown[]
) {
  return statement.bind(
    LEGACY_STATISTICS_DATE_BASIS,
    since.legacy,
    CURRENT_STATISTICS_DATE_BASIS,
    since.current,
    ...additionalValues,
  );
}

function solverDiagnosticSummaryStatement(env: WorkerEnv, since?: StatisticsWindow) {
  const query = `
    SELECT
      date_basis,
      forecast_id,
      solver_version,
      solver_phase,
      SUM(events) AS events,
      MIN(date_key) AS first_date,
      MAX(date_key) AS last_date
    FROM ${statisticsAggregateSource("solver_diagnostic_aggregates")}
    ${since ? `WHERE ${statisticsWindowPredicate()}` : ""}
    GROUP BY date_basis, forecast_id, solver_version, solver_phase
    ORDER BY date_basis ASC, events DESC, forecast_id ASC, solver_version ASC
  `;
  return since ? bindStatisticsWindow(env.DB.prepare(query), since) : env.DB.prepare(query);
}

function mapSolverDiagnosticSummary(result: D1Result<unknown>) {
  return (result.results || []).map((rawRow) => {
    const row = rawRow as SolverDiagnosticSummaryRow;
    return {
      dateBasis: statisticsDateBasis(row.date_basis),
      forecastId: String(row.forecast_id || "legacy-unversioned"),
      solverVersion: String(row.solver_version || "unknown"),
      solverPhase: String(row.solver_phase || "unknown"),
      events: Number(row.events || 0),
      firstDate: typeof row.first_date === "string" ? row.first_date : null,
      lastDate: typeof row.last_date === "string" ? row.last_date : null,
    };
  });
}

function solverDiagnosticDailyStatement(env: WorkerEnv, since: StatisticsWindow) {
  return bindStatisticsWindow(
    env.DB.prepare(
      `SELECT
       date_basis,
       date_key,
       forecast_id,
       solver_version,
       solver_phase,
       SUM(events) AS events
     FROM ${statisticsAggregateSource("solver_diagnostic_aggregates")}
     WHERE ${statisticsWindowPredicate()}
     GROUP BY date_basis, date_key, forecast_id, solver_version, solver_phase
     ORDER BY date_key DESC, date_basis ASC, events DESC, forecast_id ASC, solver_version ASC`,
    ),
    since,
  );
}

function mapSolverDiagnosticDaily(result: D1Result<unknown>) {
  return (result.results || []).map((rawRow) => {
    const row = rawRow as SolverDiagnosticDailyRow;
    return {
      dateBasis: statisticsDateBasis(row.date_basis),
      date: typeof row.date_key === "string" ? row.date_key : "",
      forecastId: String(row.forecast_id || "legacy-unversioned"),
      solverVersion: String(row.solver_version || "unknown"),
      solverPhase: String(row.solver_phase || "unknown"),
      events: Number(row.events || 0),
    };
  });
}

function solverNodeCountsStatement(env: WorkerEnv, since: StatisticsWindow) {
  return bindStatisticsWindow(
    env.DB.prepare(
      `SELECT
       date_basis,
       forecast_id,
       CASE WHEN fallback_from != 'none' THEN fallback_from ELSE solver_backend END AS solver_backend,
       attempted_node_count_bucket AS node_count_bucket,
       SUM(events) AS events
      FROM ${statisticsAggregateSource("solver_runtime_aggregates")}
      WHERE ${statisticsWindowPredicate()} AND diagnostic_version >= ?
      GROUP BY date_basis, forecast_id,
       CASE WHEN fallback_from != 'none' THEN fallback_from ELSE solver_backend END,
       attempted_node_count_bucket
      ORDER BY date_basis ASC, solver_backend ASC, events DESC`,
    ),
    since,
    TRUSTWORTHY_RUNTIME_DIAGNOSTIC_VERSION,
  );
}

function mapSolverNodeCounts(result: D1Result<unknown>) {
  return (result.results || []).map((rawRow) => {
    const row = rawRow as SolverNodeCountRow;
    return {
      dateBasis: statisticsDateBasis(row.date_basis),
      forecastId: stringOr(row.forecast_id, "legacy-unversioned"),
      solverBackend: String(row.solver_backend || "unknown"),
      nodeCountBucket: String(row.node_count_bucket || "unknown"),
      events: Number(row.events || 0),
    };
  });
}

function solverRuntimeStatement(env: WorkerEnv, since: StatisticsWindow) {
  return bindStatisticsWindow(
    env.DB.prepare(
      `SELECT
       date_basis,
       forecast_id,
       solver_version,
       solver_phase,
       solver_backend,
       fallback_from,
       fallback_reason,
       memory_strategy,
       min_ef_memo_tier,
       phase2_memo_tier,
       phase2_memo_retried,
       grade,
       level,
       exp_bucket,
       stock_bucket_blue,
       stock_bucket_purple,
       stock_bucket_yellow,
       node_count_bucket,
       attempted_node_count_bucket,
       solve_ms_bucket,
       SUM(events) AS events
      FROM ${statisticsAggregateSource("solver_runtime_aggregates")}
      WHERE ${statisticsWindowPredicate()} AND diagnostic_version >= ?
      GROUP BY date_basis, forecast_id, solver_version, solver_phase, solver_backend, fallback_from, fallback_reason,
       memory_strategy, min_ef_memo_tier, phase2_memo_tier, phase2_memo_retried,
       grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow,
        node_count_bucket, attempted_node_count_bucket, solve_ms_bucket
      ORDER BY date_basis ASC, solver_version ASC, solver_phase ASC, events DESC`,
    ),
    since,
    TRUSTWORTHY_RUNTIME_DIAGNOSTIC_VERSION,
  );
}

function mapSolverRuntime(result: D1Result<unknown>) {
  return (result.results || []).map((rawRow) => {
    const row = rawRow as SolverRuntimeRow;
    return {
      dateBasis: statisticsDateBasis(row.date_basis),
      forecastId: stringOr(row.forecast_id, "legacy-unversioned"),
      solverVersion: stringOr(row.solver_version, "unknown"),
      solverPhase: stringOr(row.solver_phase, "unknown"),
      solverBackend: stringOr(row.solver_backend, "unknown"),
      fallbackFrom: stringOr(row.fallback_from, "none"),
      fallbackReason: stringOr(row.fallback_reason, "none"),
      memoryStrategy: stringOr(row.memory_strategy, "unknown"),
      minEfMemoTier: stringOr(row.min_ef_memo_tier, "unknown"),
      phase2MemoTier: stringOr(row.phase2_memo_tier, "unknown"),
      phase2MemoRetried: stringOr(row.phase2_memo_retried, "unknown"),
      grade: stringOr(row.grade, "unknown"),
      level: numberOrZero(row.level),
      expBucket: numberOrZero(row.exp_bucket),
      stockBuckets: {
        blue: stringOr(row.stock_bucket_blue, "unknown"),
        purple: stringOr(row.stock_bucket_purple, "unknown"),
        yellow: stringOr(row.stock_bucket_yellow, "unknown"),
      },
      nodeCountBucket: stringOr(row.node_count_bucket, "unknown"),
      attemptedNodeCountBucket: stringOr(row.attempted_node_count_bucket, "unknown"),
      solveMsBucket: stringOr(row.solve_ms_bucket, "unknown"),
      events: numberOrZero(row.events),
    };
  });
}

function solverCacheStatement(env: WorkerEnv, since: StatisticsWindow) {
  return bindStatisticsWindow(
    env.DB.prepare(
      `SELECT
       date_basis,
       diagnostic_version,
       forecast_id,
       requested_backend,
       terminal_backend,
       execution_kind,
       SUM(events) AS events
      FROM ${statisticsAggregateSource("solver_cache_aggregates")}
      WHERE ${statisticsWindowPredicate()} AND diagnostic_version >= ?
      GROUP BY date_basis, diagnostic_version, forecast_id, requested_backend, terminal_backend, execution_kind
      ORDER BY date_basis ASC, diagnostic_version ASC, forecast_id ASC, requested_backend ASC, execution_kind ASC`,
    ),
    since,
    TRUSTWORTHY_RUNTIME_DIAGNOSTIC_VERSION,
  );
}

function mapSolverCache(result: D1Result<unknown>) {
  return (result.results || []).map((rawRow) => {
    const row = rawRow as SolverCacheRow;
    return {
      dateBasis: statisticsDateBasis(row.date_basis),
      diagnosticVersion: numberOrZero(row.diagnostic_version),
      forecastId: stringOr(row.forecast_id, "legacy-unversioned"),
      requestedBackend: stringOr(row.requested_backend, "unknown"),
      terminalBackend: stringOr(row.terminal_backend, "unknown"),
      executionKind: stringOr(row.execution_kind, "unknown"),
      events: numberOrZero(row.events),
    };
  });
}

function calculationLocaleStatement(env: WorkerEnv, since: StatisticsWindow) {
  return bindStatisticsWindow(
    env.DB.prepare(
      `SELECT
       date_basis,
       diagnostic_version,
       forecast_id,
       locale,
       requested_backend,
       terminal_backend,
       execution_kind,
       SUM(events) AS events
      FROM ${statisticsAggregateSource("calculation_locale_aggregates")}
      WHERE ${statisticsWindowPredicate()}
      GROUP BY date_basis, diagnostic_version, forecast_id, locale, requested_backend, terminal_backend, execution_kind
      ORDER BY date_basis ASC, locale ASC, forecast_id ASC, execution_kind ASC, requested_backend ASC`,
    ),
    since,
  );
}

function mapCalculationLocales(result: D1Result<unknown>) {
  return (result.results || []).map((rawRow) => {
    const row = rawRow as CalculationLocaleRow;
    return {
      dateBasis: statisticsDateBasis(row.date_basis),
      diagnosticVersion: numberOrZero(row.diagnostic_version),
      forecastId: stringOr(row.forecast_id, "legacy-unversioned"),
      locale: stringOr(row.locale, "unknown"),
      requestedBackend: stringOr(row.requested_backend, "unknown"),
      terminalBackend: stringOr(row.terminal_backend, "unknown"),
      executionKind: stringOr(row.execution_kind, "unknown"),
      events: numberOrZero(row.events),
    };
  });
}

function solverRecoveryRungStatement(env: WorkerEnv, since: StatisticsWindow) {
  return bindStatisticsWindow(
    env.DB.prepare(
      `SELECT date_basis, forecast_id, policy_version, requested_backend, rung_backend, rung_exit, device_type,
             SUM(events) AS events
     FROM ${statisticsAggregateSource("solver_recovery_rung_aggregates")}
     WHERE ${statisticsWindowPredicate()}
     GROUP BY date_basis, forecast_id, policy_version, requested_backend, rung_backend, rung_exit, device_type
     ORDER BY date_basis ASC, events DESC, rung_backend ASC`,
    ),
    since,
  );
}

function mapSolverRecoveryRungs(result: D1Result<unknown>) {
  return (result.results || []).map((rawRow) => {
    const row = rawRow as SolverRecoveryRungRow;
    return {
      dateBasis: statisticsDateBasis(row.date_basis),
      forecastId: stringOr(row.forecast_id, "legacy-unversioned"),
      policyVersion: stringOr(row.policy_version, "unknown"),
      requestedBackend: stringOr(row.requested_backend, "unknown"),
      rungBackend: stringOr(row.rung_backend, "unknown"),
      rungExit: stringOr(row.rung_exit, "unknown"),
      deviceType: stringOr(row.device_type, "unknown"),
      events: numberOrZero(row.events),
    };
  });
}

function solverRecoveryTerminalStatement(env: WorkerEnv, since: StatisticsWindow) {
  return bindStatisticsWindow(
    env.DB.prepare(
      `SELECT date_basis, forecast_id, policy_version, requested_backend, terminal_backend, terminal_outcome,
             SUM(events) AS events
     FROM ${statisticsAggregateSource("solver_recovery_terminal_aggregates")}
     WHERE ${statisticsWindowPredicate()}
     GROUP BY date_basis, forecast_id, policy_version, requested_backend, terminal_backend, terminal_outcome
     ORDER BY date_basis ASC, events DESC, terminal_backend ASC`,
    ),
    since,
  );
}

function mapSolverRecoveryTerminals(result: D1Result<unknown>) {
  return (result.results || []).map((rawRow) => {
    const row = rawRow as SolverRecoveryTerminalRow;
    return {
      dateBasis: statisticsDateBasis(row.date_basis),
      forecastId: stringOr(row.forecast_id, "legacy-unversioned"),
      policyVersion: stringOr(row.policy_version, "unknown"),
      requestedBackend: stringOr(row.requested_backend, "unknown"),
      terminalBackend: stringOr(row.terminal_backend, "none"),
      terminalOutcome: stringOr(row.terminal_outcome, "unknown"),
      events: numberOrZero(row.events),
    };
  });
}

function runtimeInvariantStatement(env: WorkerEnv, since: StatisticsWindow) {
  return bindStatisticsWindow(
    env.DB.prepare(
      `SELECT date_basis, invariant_version, invariant_code, component, lane, device_type,
             SUM(events) AS events, MAX(last_seen) AS last_seen
     FROM ${statisticsAggregateSource("runtime_invariant_aggregates")}
     WHERE ${statisticsWindowPredicate()}
     GROUP BY date_basis, invariant_version, invariant_code, component, lane, device_type
     ORDER BY date_basis ASC, events DESC, invariant_code ASC`,
    ),
    since,
  );
}

function mapRuntimeInvariants(result: D1Result<unknown>) {
  return (result.results || []).map((rawRow) => {
    const row = rawRow as RuntimeInvariantRow;
    return {
      dateBasis: statisticsDateBasis(row.date_basis),
      invariantVersion: numberOrZero(row.invariant_version),
      code: stringOr(row.invariant_code, "unknown"),
      component: stringOr(row.component, "unknown"),
      lane: stringOr(row.lane, "unknown"),
      deviceType: stringOr(row.device_type, "unknown"),
      events: numberOrZero(row.events),
      lastSeen: numberOrZero(row.last_seen),
    };
  });
}

function stringOr(value: string | null | undefined, fallback: string) {
  return value ? String(value) : fallback;
}

function statisticsDateBasis(value: string | null | undefined) {
  return value === CURRENT_STATISTICS_DATE_BASIS
    ? CURRENT_STATISTICS_DATE_BASIS
    : LEGACY_STATISTICS_DATE_BASIS;
}

function numberOrZero(value: number | string | null | undefined) {
  return value ? Number(value) : 0;
}

function summarizeFallbacks(runtime: ReturnType<typeof mapSolverRuntime>) {
  const grouped = new Map<
    string,
    {
      dateBasis: ReturnType<typeof statisticsDateBasis>;
      forecastId: string;
      attemptedBackend: string;
      events: number;
      fallbackEvents: number;
    }
  >();
  for (const row of runtime) {
    const attemptedBackend = row.fallbackFrom !== "none" ? row.fallbackFrom : row.solverBackend;
    const key = `${row.dateBasis}\0${row.forecastId}\0${attemptedBackend}`;
    const item = grouped.get(key) || {
      dateBasis: row.dateBasis,
      forecastId: row.forecastId,
      attemptedBackend,
      events: 0,
      fallbackEvents: 0,
    };
    item.events += row.events;
    if (row.fallbackReason !== "none") item.fallbackEvents += row.events;
    grouped.set(key, item);
  }
  return [...grouped.values()].map((item) => ({
    ...item,
    fallbackRate: item.events > 0 ? item.fallbackEvents / item.events : 0,
  }));
}

function summarizeLatencyBuckets(runtime: ReturnType<typeof mapSolverRuntime>) {
  const grouped = new Map<
    string,
    {
      dateBasis: ReturnType<typeof statisticsDateBasis>;
      forecastId: string;
      solverVersion: string;
      solverPhase: string;
      solverBackend: string;
      solveMsBucket: string;
      events: number;
    }
  >();
  for (const row of runtime) {
    const key = `${row.dateBasis}\0${row.forecastId}\0${row.solverVersion}\0${row.solverPhase}\0${row.solverBackend}\0${row.solveMsBucket}`;
    const item = grouped.get(key) || {
      dateBasis: row.dateBasis,
      forecastId: row.forecastId,
      solverVersion: row.solverVersion,
      solverPhase: row.solverPhase,
      solverBackend: row.solverBackend,
      solveMsBucket: row.solveMsBucket,
      events: 0,
    };
    item.events += row.events;
    grouped.set(key, item);
  }
  return [...grouped.values()].sort((a, b) => {
    const basis = a.dateBasis.localeCompare(b.dateBasis);
    if (basis !== 0) return basis;
    const forecast = a.forecastId.localeCompare(b.forecastId);
    if (forecast !== 0) return forecast;
    const version = a.solverVersion.localeCompare(b.solverVersion);
    if (version !== 0) return version;
    return b.events - a.events;
  });
}
