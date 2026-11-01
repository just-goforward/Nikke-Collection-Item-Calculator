import { errorCode } from "../../shared/errorCodes";
import { DECISION_ANALYTICS_ENDPOINT } from "../../shared/decisionAnalyticsV3";
import { handleAdminSolverDiagnostics } from "./admin-solver-diagnostics";
import { cleanupDecisionAnalytics, handleDecisionEvent } from "./decision-analytics.ts";
import { runStatisticsCleanupJobs } from "./decision-analytics-maintenance.ts";
import {
  createProductionDecisionResolver,
  type DecisionMetadataInstallation,
  type DecisionRequestResolver,
} from "./decision-analytics-publication.ts";
import type { WorkerEnv } from "./env";
import { handleEvent } from "./event-submission";
import { handleOptions, jsonResponse } from "./http";
import { HttpError } from "./http-error";
import { logError } from "./logger";
import { assertQuotaAllows } from "./quota-guard";
import { cleanupExpiredStatistics } from "./rate-limit";
import { handleSchemaHealth } from "./schema-health";
import { handleStats } from "./stats-read";
import { cleanupOutcomeFacts } from "./outcome-facts";
export { Ingest, PublicStats, RawReader, Diagnostics } from "./stats-capabilities";

async function dispatchRequest(request: Request, env: WorkerEnv, resolveDecision?: DecisionRequestResolver) {
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
  if (url.pathname === DECISION_ANALYTICS_ENDPOINT && request.method === "POST")
    return await handleDecisionEvent(request, env,
      resolveDecision ? (req, calculation) => resolveDecision(req, env, calculation) : undefined);
  return jsonResponse(request, env, { error: "not_found" }, 404);
}

export const createStatsWorker = (resolveDecision?: DecisionRequestResolver): ExportedHandler<WorkerEnv> => ({
  async fetch(request: Request, env: WorkerEnv) {
    try {
      // Named capabilities are the only interface after the approved cutover.
      if (env.STATS_CAPABILITY_CUTOVER === "true")
        return jsonResponse(request, env, { error: "not_found" }, 404);
      return await dispatchRequest(request, env, resolveDecision);
    } catch (error) {
      const expected = error instanceof HttpError;
      const status = expected ? error.status : 500;
      const message = expected ? error.message : "internal_error";
      if (!expected) {
        logError("unhandled_worker_error", {
          error: errorCode(error),
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
    const cleanup = runStatisticsCleanupJobs({
      legacy: async () => {
        await assertQuotaAllows(env, "statistics_write");
        await cleanupExpiredStatistics(env, Math.floor(Date.now() / 1000));
      },
      analytics: async () => {
        const jobs = await Promise.allSettled([
          cleanupDecisionAnalytics(env, Date.now()), cleanupOutcomeFacts(env, Date.now()),
        ]);
        if (jobs.some(job => job.status === "rejected")) throw new Error("analytics_cleanup_failed");
      },
      reportLegacy: (error) => {
        logError("statistics_cleanup_failed", { error: errorCode(error) });
      },
      reportAnalytics: (error) => {
        logError("decision_analytics_cleanup_failed", { error: errorCode(error) });
      },
    });
    ctx.waitUntil(cleanup);
  },
});

/** Static v3 compatibility remains explicit; production injection never falls back
 * to an opaque configured hash when its authenticated mapping is unavailable. */
export function createProductionStatsWorker(installation?: DecisionMetadataInstallation) {
  return createStatsWorker(createProductionDecisionResolver(installation));
}

const worker = createStatsWorker();

export default worker;
