import { runDispatcher } from "./dispatcher";
import type { DispatcherEnv } from "./types";

export default {
  async scheduled(event, env, context) {
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
    context.waitUntil(runDispatcher(env, { scheduledTime: event.scheduledTime }));
  },

  fetch() {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  },
} satisfies ExportedHandler<DispatcherEnv>;
