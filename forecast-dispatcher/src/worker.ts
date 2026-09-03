import { assertUsageAllowed, UsageGuardError } from "../../shared/usageGuard";
import { runDispatcher } from "./dispatcher";
import type { DispatcherEnv } from "./types";

export default {
  async scheduled(event, env, context) {
    console.log(
      JSON.stringify({
        event: "forecast_canary_scheduled_invocation",
        component: "dispatcher",
        environment: env.ENVIRONMENT,
        deploymentSha: env.DEPLOY_SHA,
        slot: new Date(event.scheduledTime).toISOString(),
      }),
    );
    if (env.DISPATCH_ENABLED !== "true") {
      console.log(
        JSON.stringify({
          event: "forecast_dispatcher_disabled",
          environment: env.ENVIRONMENT,
          deploymentSha: env.DEPLOY_SHA,
        }),
      );
      return;
    }
    try {
      await assertUsageAllowed(
        env.USAGE_GUARD_DB,
        env.ENVIRONMENT === "staging" ? "staging_automation" : "production_forecast_automation",
      );
    } catch (error) {
      if (!(error instanceof UsageGuardError)) throw error;
      console.warn(
        JSON.stringify({
          event: "forecast_dispatcher_quota_disabled",
          environment: env.ENVIRONMENT,
          action: error.action,
          errorCode: error.code,
        }),
      );
      return;
    }
    context.waitUntil(runDispatcher(env, { scheduledTime: event.scheduledTime }));
  },

  fetch() {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  },
} satisfies ExportedHandler<DispatcherEnv>;
