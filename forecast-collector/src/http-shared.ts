import { assertUsageAllowed, UsageGuardError } from "../../shared/usageGuard.ts";
import type { CollectorEnv } from "./types";

export type AdminRequestContext = {
  request: Request;
  url: URL;
  env: CollectorEnv;
  executionContext: ExecutionContext;
};

export type AdminRouteHandler = (context: AdminRequestContext) => Promise<Response | null>;

export function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function opsEnvironment(env: CollectorEnv) {
  return env.ENVIRONMENT === "production" ? "production" : "staging";
}

export function automationOperation(env: CollectorEnv) {
  return env.ENVIRONMENT === "production"
    ? ("production_forecast_automation" as const)
    : ("staging_automation" as const);
}

export async function enforceUsageGuard(
  env: CollectorEnv,
  operation: "admin_read" | "production_forecast_automation" | "staging_automation",
) {
  try {
    await assertUsageAllowed(requireGuardDb(env), operation);
    return null;
  } catch (error) {
    if (error instanceof UsageGuardError) {
      return json({ error: error.code, retryable: false, action: error.action }, 503);
    }
    throw error;
  }
}

export function requireGuardDb(env: CollectorEnv) {
  if (!env.USAGE_GUARD_DB) throw new UsageGuardError("hard_stop");
  return env.USAGE_GUARD_DB;
}

export function adminRouteGroup(pathname: string) {
  if (pathname.startsWith("/admin/workflow-dispatches/")) return "workflow-dispatches";
  if (pathname.startsWith("/admin/manual-reviews/")) return "manual-reviews";
  if (pathname.startsWith("/admin/source-queue")) return "source-queue";
  if (pathname.startsWith("/admin/discord-")) return "discord";
  if (pathname.startsWith("/admin/candidates")) return "candidates";
  if (pathname.startsWith("/admin/ops-alerts")) return "ops-alerts";
  return pathname.slice("/admin/".length).split("/")[0] || "root";
}
