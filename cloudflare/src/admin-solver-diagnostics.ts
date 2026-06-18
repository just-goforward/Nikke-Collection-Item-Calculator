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

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;

export async function handleAdminSolverDiagnostics(request: Request, env: WorkerEnv) {
  assertAdminRequest(request, env);
  const now = Math.floor(Date.now() / 1000);
  const windowDays = readWindowDays(request);
  const since = kstDateKeyFromUnixSeconds(now - 86400 * windowDays);

  const [allTime, window, daily, nodeCounts] = await Promise.all([
    readSolverDiagnosticSummary(env),
    readSolverDiagnosticSummary(env, since),
    readSolverDiagnosticDaily(env, since),
    readSolverNodeCounts(env, since),
  ]);

  return jsonResponse(request, env, {
    generatedAt: new Date(now * 1000).toISOString(),
    windowDays,
    since,
    allTime,
    window,
    daily,
    nodeCounts,
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
