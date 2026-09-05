import { handleAdminRoute } from "./admin-router";
import { timingSafeBearer } from "./crypto";
import { readHealth } from "./db";
import { handleDiscordInteraction } from "./discord-approval";
import {
  adminRouteGroup,
  automationOperation,
  enforceUsageGuard,
  json,
  opsEnvironment,
} from "./http-shared";
import { readOperationsHealth } from "./ops";
import type { CollectorEnv } from "./types";

export async function handleHttpRequest(
  request: Request,
  env: CollectorEnv,
  executionContext: ExecutionContext,
) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    const quotaResponse = await enforceUsageGuard(env, "admin_read");
    if (quotaResponse) return quotaResponse;
    return json({
      ...(await readHealth(env.FORECAST_DB)),
      operations: await readOperationsHealth(env.FORECAST_DB, opsEnvironment(env)),
    });
  }
  if (request.method === "POST" && url.pathname === "/discord/interactions") {
    const quotaResponse = await enforceUsageGuard(env, automationOperation(env));
    if (quotaResponse) return quotaResponse;
    const rateLimitResponse = await enforceDiscordRateLimit(request, env);
    if (rateLimitResponse) return rateLimitResponse;
    return handleDiscordInteraction(request, env, executionContext);
  }
  if (!url.pathname.startsWith("/admin/")) return new Response("Not found", { status: 404 });

  const unauthenticatedLimit = await enforceUnauthenticatedAdminRateLimit(request, env);
  if (unauthenticatedLimit) return unauthenticatedLimit;
  if (!(await timingSafeBearer(request, env.ADMIN_TOKEN))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const authenticatedLimit = await enforceAuthenticatedAdminRateLimit(request, url, env);
  if (authenticatedLimit) return authenticatedLimit;
  const quotaResponse = await enforceUsageGuard(
    env,
    request.method === "GET" ? "admin_read" : automationOperation(env),
  );
  if (quotaResponse) return quotaResponse;
  return handleAdminRoute({ request, url, env, executionContext });
}

async function enforceDiscordRateLimit(request: Request, env: CollectorEnv) {
  if (!env.ADMIN_RATE_LIMITER) return missingRateLimiter(env);
  const sourceAddress = request.headers.get("cf-connecting-ip") ?? "unknown";
  const result = await env.ADMIN_RATE_LIMITER.limit({
    key: `discord-interactions:${sourceAddress}`,
  });
  return result.success ? null : new Response("Too many requests", { status: 429 });
}

async function enforceUnauthenticatedAdminRateLimit(request: Request, env: CollectorEnv) {
  if (!env.ADMIN_RATE_LIMITER) return missingRateLimiter(env);
  const sourceAddress = request.headers.get("cf-connecting-ip") ?? "unknown";
  const result = await env.ADMIN_RATE_LIMITER.limit({
    key: `admin-unauth:${sourceAddress}`,
  });
  return result.success ? null : new Response("Too many requests", { status: 429 });
}

async function enforceAuthenticatedAdminRateLimit(request: Request, url: URL, env: CollectorEnv) {
  if (!env.ADMIN_RATE_LIMITER) return null;
  const result = await env.ADMIN_RATE_LIMITER.limit({
    key: `admin-auth:${request.method}:${adminRouteGroup(url.pathname)}`,
  });
  return result.success ? null : new Response("Too many requests", { status: 429 });
}

function missingRateLimiter(env: CollectorEnv) {
  return env.ENVIRONMENT === "test" ? null : new Response("Service unavailable", { status: 503 });
}
