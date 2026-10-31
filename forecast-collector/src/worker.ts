import { assertUsageAllowed, UsageGuardError } from "../../shared/usageGuard.ts";
import { handleHttpRequest } from "./http";
import { automationOperation, opsEnvironment, requireGuardDb } from "./http-shared";
import type { CollectorEnv } from "./types";
import { runV2CandidateUnit } from "./v2/candidate";
import { runV2Invocation } from "./v2/ingest/run";
import { v2Mode } from "./v2/ingest/schedule";
import { configureRules, rulesPort } from "./v2/rules";

export default {
  async scheduled(event, env, context) {
    const mode = v2Mode(env);
    const marker = (admission: "admitted" | "skipped", reason?: string) =>
      console.log(
        JSON.stringify({
          event: "forecast_v2_scheduled_invocation",
          component: "collector",
          environment: env.ENVIRONMENT,
          deploymentSha: env.DEPLOY_SHA,
          slot: new Date(event.scheduledTime).toISOString(),
          mode,
          admission,
          ...(reason ? { reason } : {}),
        }),
      );
    if (env.COLLECT_ENABLED !== "true") {
      marker("skipped", "collection_disabled");
      console.log(
        JSON.stringify({
          event: "forecast_collection_skipped",
          environment: env.ENVIRONMENT,
          reason: "collection_disabled",
        }),
      );
      return;
    }
    if (mode === "off") {
      marker("skipped", "v2_off");
      return;
    }
    try {
      await assertUsageAllowed(requireGuardDb(env), automationOperation(env));
    } catch (error) {
      if (error instanceof UsageGuardError) {
        marker("skipped", "usage_guard");
        console.warn(
          JSON.stringify({
            event: "forecast_collection_quota_disabled",
            environment: env.ENVIRONMENT,
            action: error.action,
          }),
        );
        return;
      }
      marker("skipped", "usage_guard_error");
      throw error;
    }
    marker("admitted");
    context.waitUntil(runV2Scheduled(env, event.scheduledTime));
  },

  fetch(request, env, context) {
    return handleHttpRequest(request, env, context);
  },
} satisfies ExportedHandler<CollectorEnv>;

function runV2Scheduled(env: CollectorEnv, scheduledTime: number) {
  if (v2Mode(env) === "on") {
    configureRules({ environment: opsEnvironment(env) });
    return runV2Invocation(env, scheduledTime, {
      rules: rulesPort,
      candidate: runV2CandidateUnit,
    });
  }
  return runV2Invocation(env, scheduledTime);
}
