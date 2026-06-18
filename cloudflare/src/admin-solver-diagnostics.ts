import type { WorkerEnv } from "./env";
import { isAllowedOrigin, jsonResponse } from "./http";
import { HttpError } from "./http-error";
import { kstDateKeyFromUnixSeconds } from "./stats-read";

type SolverDiagnosticSummaryRow = {
  solver_version?: string | null;
  solver_phase?: string | null;
  events?: number | string | null;
  first_date?: string | null;
  last_date?: string | null;
};

type SolverDiagnosticDailyRow = {
  date_key?: string | null;
  solver_version?: string | null;
  solver_phase?: string | null;
  events?: number | string | null;
};

type SolverNodeCountRow = {
  solver_version?: string | null;
  solver_phase?: string | null;
  node_count_bucket?: string | null;
  events?: number | string | null;
};

type SolverRuntimeRow = {
  solver_version?: string | null;
  solver_phase?: string | null;
  solver_backend?: string | null;
  fallback_from?: string | null;
  fallback_reason?: string | null;
  grade?: string | null;
  level?: number | string | null;
  exp_bucket?: number | string | null;
  stock_bucket_blue?: string | null;
  stock_bucket_purple?: string | null;
  stock_bucket_yellow?: string | null;
  node_count_bucket?: string | null;
  solve_ms_bucket?: string | null;
  events?: number | string | null;
};

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;

export async function handleAdminSolverDiagnostics(request: Request, env: WorkerEnv) {
  assertAdminRequest(request, env);
  const now = Math.floor(Date.now() / 1000);
  const windowDays = readWindowDays(request);
  const since = kstDateKeyFromUnixSeconds(now - 86400 * windowDays);

  const [allTime, window, daily, nodeCounts, runtime] = await Promise.all([
    readSolverDiagnosticSummary(env),
    readSolverDiagnosticSummary(env, since),
    readSolverDiagnosticDaily(env, since),
    readSolverNodeCounts(env, since),
    readSolverRuntime(env, since),
  ]);

  return jsonResponse(request, env, {
    generatedAt: new Date(now * 1000).toISOString(),
    windowDays,
    since,
    allTime,
    window,
    daily,
    nodeCounts,
    runtime,
    fallbacks: summarizeFallbacks(runtime),
    latencies: summarizeLatencyBuckets(runtime),
  });
}

function assertAdminRequest(request: Request, env: WorkerEnv) {
  if (!isAllowedOrigin(request, env)) throw new HttpError(403, "origin_not_allowed");
  if (!env.DB) throw new HttpError(500, "database_not_configured");
  if (!env.ADMIN_TOKEN) throw new HttpError(404, "not_found");
  if (bearerToken(request) !== env.ADMIN_TOKEN) throw new HttpError(403, "admin_forbidden");
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

async function readSolverDiagnosticSummary(env: WorkerEnv, since?: string) {
  const query = `
    SELECT
      solver_version,
      solver_phase,
      SUM(events) AS events,
      MIN(date_key) AS first_date,
      MAX(date_key) AS last_date
    FROM solver_diagnostic_aggregates
    ${since ? "WHERE date_key >= ?" : ""}
    GROUP BY solver_version, solver_phase
    ORDER BY events DESC, solver_version ASC
  `;
  const result = since
    ? await env.DB.prepare(query).bind(since).all<SolverDiagnosticSummaryRow>()
    : await env.DB.prepare(query).all<SolverDiagnosticSummaryRow>();

  return (result.results || []).map((row) => ({
    solverVersion: String(row.solver_version || "unknown"),
    solverPhase: String(row.solver_phase || "unknown"),
    events: Number(row.events || 0),
    firstDate: typeof row.first_date === "string" ? row.first_date : null,
    lastDate: typeof row.last_date === "string" ? row.last_date : null,
  }));
}

async function readSolverDiagnosticDaily(env: WorkerEnv, since: string) {
  const result = await env.DB.prepare(
    `SELECT
       date_key,
       solver_version,
       solver_phase,
       SUM(events) AS events
     FROM solver_diagnostic_aggregates
     WHERE date_key >= ?
     GROUP BY date_key, solver_version, solver_phase
     ORDER BY date_key DESC, events DESC, solver_version ASC`,
  )
    .bind(since)
    .all<SolverDiagnosticDailyRow>();

  return (result.results || []).map((row) => ({
    date: typeof row.date_key === "string" ? row.date_key : "",
    solverVersion: String(row.solver_version || "unknown"),
    solverPhase: String(row.solver_phase || "unknown"),
    events: Number(row.events || 0),
  }));
}

async function readSolverNodeCounts(env: WorkerEnv, since: string) {
  const result = await env.DB.prepare(
    `SELECT
       solver_version,
       solver_phase,
       node_count_bucket,
       SUM(events) AS events
     FROM solver_node_count_aggregates
     WHERE date_key >= ?
     GROUP BY solver_version, solver_phase, node_count_bucket
     ORDER BY solver_version ASC, solver_phase ASC, events DESC`,
  )
    .bind(since)
    .all<SolverNodeCountRow>();

  return (result.results || []).map((row) => ({
    solverVersion: String(row.solver_version || "unknown"),
    solverPhase: String(row.solver_phase || "unknown"),
    nodeCountBucket: String(row.node_count_bucket || "unknown"),
    events: Number(row.events || 0),
  }));
}

async function readSolverRuntime(env: WorkerEnv, since: string) {
  const result = await env.DB.prepare(
    `SELECT
       solver_version,
       solver_phase,
       solver_backend,
       fallback_from,
       fallback_reason,
       grade,
       level,
       exp_bucket,
       stock_bucket_blue,
       stock_bucket_purple,
       stock_bucket_yellow,
       node_count_bucket,
       solve_ms_bucket,
       SUM(events) AS events
     FROM solver_runtime_aggregates
     WHERE date_key >= ?
     GROUP BY solver_version, solver_phase, solver_backend, fallback_from, fallback_reason,
       grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow,
       node_count_bucket, solve_ms_bucket
     ORDER BY solver_version ASC, solver_phase ASC, events DESC`,
  )
    .bind(since)
    .all<SolverRuntimeRow>();

  return (result.results || []).map((row) => ({
    solverVersion: String(row.solver_version || "unknown"),
    solverPhase: String(row.solver_phase || "unknown"),
    solverBackend: String(row.solver_backend || "unknown"),
    fallbackFrom: String(row.fallback_from || "none"),
    fallbackReason: String(row.fallback_reason || "none"),
    grade: String(row.grade || "unknown"),
    level: Number(row.level || 0),
    expBucket: Number(row.exp_bucket || 0),
    stockBuckets: {
      blue: String(row.stock_bucket_blue || "unknown"),
      purple: String(row.stock_bucket_purple || "unknown"),
      yellow: String(row.stock_bucket_yellow || "unknown"),
    },
    nodeCountBucket: String(row.node_count_bucket || "unknown"),
    solveMsBucket: String(row.solve_ms_bucket || "unknown"),
    events: Number(row.events || 0),
  }));
}

function summarizeFallbacks(runtime: Awaited<ReturnType<typeof readSolverRuntime>>) {
  const grouped = new Map<
    string,
    {
      solverVersion: string;
      solverPhase: string;
      solverBackend: string;
      events: number;
      fallbackEvents: number;
    }
  >();
  for (const row of runtime) {
    const key = `${row.solverVersion}\0${row.solverPhase}\0${row.solverBackend}`;
    const item = grouped.get(key) || {
      solverVersion: row.solverVersion,
      solverPhase: row.solverPhase,
      solverBackend: row.solverBackend,
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

function summarizeLatencyBuckets(runtime: Awaited<ReturnType<typeof readSolverRuntime>>) {
  const grouped = new Map<
    string,
    {
      solverVersion: string;
      solverPhase: string;
      solverBackend: string;
      solveMsBucket: string;
      events: number;
    }
  >();
  for (const row of runtime) {
    const key = `${row.solverVersion}\0${row.solverPhase}\0${row.solverBackend}\0${row.solveMsBucket}`;
    const item = grouped.get(key) || {
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
    const version = a.solverVersion.localeCompare(b.solverVersion);
    if (version !== 0) return version;
    return b.events - a.events;
  });
}
