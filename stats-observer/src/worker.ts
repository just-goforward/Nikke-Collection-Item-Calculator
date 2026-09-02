import { runObserver } from "./observer";
import type { StatsObserverEnv } from "./types";

const worker = {
  fetch() {
    return Response.json({ error: "not_found" }, { status: 404 });
  },
  scheduled(
    controller: { scheduledTime: number },
    env: StatsObserverEnv,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) {
    ctx.waitUntil(
      runObserver(env, controller.scheduledTime).catch((error) => {
        const code =
          error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message)
            ? error.message
            : "observer_internal_error";
        console.error(
          JSON.stringify({
            level: "error",
            event: "stats_observer_failed",
            code,
          }),
        );
        // Preserve a failed invocation without exposing a raw provider or D1 error.
        throw new Error(code);
      }),
    );
  },
};

export default worker;
