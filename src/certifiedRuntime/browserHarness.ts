import { createCertifiedClient } from "./client.ts";
import type { LifecycleFixtureInput } from "./lifecycleFixtureWorker.ts";
import type { CertifiedResponse } from "./protocol.ts";

/** Browser integration fixture with actual module Workers. */
export function createLifecycleBrowserHarness() {
  const state = { created: 0, terminated: 0, staleErrors: [] as Array<(error: unknown) => void> };
  const client = createCertifiedClient<LifecycleFixtureInput, string>({
    idleTimeoutMs: 50,
    createWorker: () => {
      const worker = new Worker(new URL("./browserFixtureWorker.ts", import.meta.url), {
        type: "module",
      });
      state.created++;
      return {
        runtime: "browser",
        postMessage: (message) => worker.postMessage(message),
        terminate: () => {
          state.terminated++;
          worker.terminate();
        },
        listen: (message, error) => {
          state.staleErrors.push(error);
          const onMessage = (event: MessageEvent<CertifiedResponse<string>>) => message(event.data);
          const onError = (event: ErrorEvent) => error(event.message);
          worker.addEventListener("message", onMessage);
          worker.addEventListener("error", onError);
          return () => {
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
          };
        },
      };
    },
  });
  return { client, state };
}
