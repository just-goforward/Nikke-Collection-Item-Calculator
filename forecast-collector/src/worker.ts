import { assertUsageAllowed, UsageGuardError } from "../../shared/usageGuard.ts";
import { runCollection } from "./collector";
import { handleHttpRequest } from "./http";
import { automationOperation, requireGuardDb } from "./http-shared";
import type { CollectorEnv } from "./types";

export default {
  async scheduled(event, env, context) {
    console.log(
      JSON.stringify({
        event: "forecast_canary_scheduled_invocation",
        component: "collector",
        environment: env.ENVIRONMENT,
        deploymentSha: env.DEPLOY_SHA,
        slot: new Date(event.scheduledTime).toISOString(),
      }),
    );
    if (env.COLLECT_ENABLED !== "true") {
      console.log(
        JSON.stringify({
          event: "forecast_collection_skipped",
          environment: env.ENVIRONMENT,
          reason: "collection_disabled",
        }),
      );
      return;
    }
    try {
      await assertUsageAllowed(requireGuardDb(env), automationOperation(env));
    } catch (error) {
      if (error instanceof UsageGuardError) {
        console.warn(
          JSON.stringify({
            event: "forecast_collection_quota_disabled",
            environment: env.ENVIRONMENT,
            action: error.action,
          }),
        );
        return;
      }
      throw error;
    }
    context.waitUntil(runCollection(env, { nowMs: event.scheduledTime }));
  },

  fetch(request, env, context) {
    return handleHttpRequest(request, env, context);
  },
} satisfies ExportedHandler<CollectorEnv>;
