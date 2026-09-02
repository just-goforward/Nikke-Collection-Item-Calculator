import { handleAdminSolverDiagnostics } from "./admin-solver-diagnostics";
import type { WorkerEnv } from "./env";
import { handleEvent } from "./event-submission";
import { handleOptions, jsonResponse } from "./http";
import { HttpError } from "./http-error";
import { logError, sanitizedError } from "./logger";
import { assertQuotaAllows } from "./quota-guard";
import { cleanupExpiredStatistics } from "./rate-limit";
import { handleSchemaHealth } from "./schema-health";
import { handleStats } from "./stats-read";

async function dispatchRequest(request: Request, env: WorkerEnv) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return handleOptions(request, env);
  if (url.pathname === "/api/admin/solver-diagnostics" && request.method === "GET")
    return await handleAdminSolverDiagnostics(request, env);
  if (url.pathname === "/api/stats" && request.method === "GET")
    return await handleStats(request, env);
  if (url.pathname === "/api/health" && request.method === "GET")
    return await handleSchemaHealth(request, env);
  if (url.pathname === "/api/events" && request.method === "POST")
    return await handleEvent(request, env);
  return jsonResponse(request, env, { error: "not_found" }, 404);
}

const worker: ExportedHandler<WorkerEnv> = {
  async fetch(request: Request, env: WorkerEnv) {
    try {
      return await dispatchRequest(request, env);
    } catch (error) {
      const expected = error instanceof HttpError;
      const status = expected ? error.status : 500;
      const message = expected ? error.message : "internal_error";
      if (!expected) {
        logError("unhandled_worker_error", {
          error: sanitizedError(error),
          path: new URL(request.url).pathname,
        });
      }
      const body: { error: string; retryable?: boolean } = {
        error: message || "internal_error",
      };
      if (error instanceof HttpError && typeof error.retryable === "boolean") {
        body.retryable = error.retryable;
      }
      return jsonResponse(request, env, body, status);
    }
  },
  scheduled(_controller, env, ctx) {
    const cleanup = assertQuotaAllows(env, "statistics_write")
      .then(() => cleanupExpiredStatistics(env, Math.floor(Date.now() / 1000)))
      .catch((error) => {
        logError("statistics_cleanup_failed", { error: sanitizedError(error) });
      });
    ctx.waitUntil(cleanup);
  },
};

export default worker;
