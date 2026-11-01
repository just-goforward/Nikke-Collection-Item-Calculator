import type { WorkerEnv } from "./env";
import { trustedClientIp } from "./client-ip";
import { readJsonPayload } from "./event-submission";
import { isAllowedOrigin, jsonResponse } from "./http";
import { HttpError } from "./http-error";
import { assertQuotaAllows } from "./quota-guard";
import { verifyTurnstile } from "./turnstile";
import { handleDecisionAnalytics, type HandlerPorts } from "./decision-analytics-handler.ts";
import { D1DecisionAnalyticsStore } from "./decision-analytics-store.ts";
import { runDecisionAnalyticsMaintenance } from "./decision-analytics-maintenance.ts";

export function handleDecisionEvent(
  request: Request,
  env: WorkerEnv,
  authorizeCalculation?: HandlerPorts["authorizeCalculation"],
): Promise<Response> {
  return handleDecisionAnalytics(request, env, {
    ...(authorizeCalculation ? { authorizeCalculation } : {}),
    now: Date.now, nonce: () => crypto.randomUUID(),
    allowed: (req) => isAllowedOrigin(req, env),
    readPayload: readJsonPayload,
    limit: async (req) => {
      // Security-only IP; never put it in episode/dedupe/counters/logs.
      const result = await env.EVENT_RATE_LIMITER.limit({ key: trustedClientIp(req) });
      if (!result.success) throw new HttpError(429, "rate_limited", false);
    },
    verify: (req, token) => verifyTurnstile(req, env, token, "decision_episode"),
    guard: () => assertQuotaAllows(env, "statistics_write").then(() => undefined),
    store: () => new D1DecisionAnalyticsStore(env.DB),
    respond: (body, status) => jsonResponse(request, env, body, status),
    expectedError: (error) => error instanceof HttpError
      ? { status: error.status, code: error.message, retryable: error.retryable === true } : null,
  });
}

/** Standalone guard checked here too; never rely on an unbounded legacy cleanup pass. */
export async function cleanupDecisionAnalytics(env: WorkerEnv, now: number): Promise<void> {
  await runDecisionAnalyticsMaintenance(env, now, {
    guard: () => assertQuotaAllows(env, "statistics_write").then(() => undefined),
    cleanup: (time, rows) => new D1DecisionAnalyticsStore(env.DB).cleanup(time, rows),
  });
}
