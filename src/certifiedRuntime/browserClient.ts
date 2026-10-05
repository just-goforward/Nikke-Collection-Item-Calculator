import type { CertifiedInput } from "../certified/types.ts";
import {
  assertTrustedCertifiedForecast,
  trustedCertifiedForecastWorkspaceBound,
} from "../lib/certifiedForecastTrust.ts";
import { type CertifiedWorkerPort, createCertifiedClient } from "./client.ts";
import { assertCertifiedOutputBinding, type CertifiedRuntimeOutput } from "./outputBinding.ts";
import { interruptedCertifiedWaiting } from "./partial.ts";
import type { CertifiedResponse } from "./protocol.ts";

export function createBrowserCertifiedClient(options: { idleTimeoutMs?: number } = {}) {
  return createCertifiedClient<CertifiedInput, CertifiedRuntimeOutput>({
    ...options,
    preservePartial: interruptedCertifiedWaiting,
    validateOutputBinding: assertCertifiedOutputBinding,
    bindForecastIdentity: (input, track) => assertTrustedCertifiedForecast(input.snapshot, track),
    forecastIdentityWorkspaceBound: (input) =>
      trustedCertifiedForecastWorkspaceBound(input.snapshot),
    createWorker: () => {
      const worker = new Worker(new URL("./browserWorker.ts", import.meta.url), {
        type: "module",
        name: "certified-staging",
      });
      const port: CertifiedWorkerPort<CertifiedInput, CertifiedRuntimeOutput> = {
        runtime: "browser",
        postMessage: (message) => worker.postMessage(message),
        terminate: () => worker.terminate(),
        listen: (message, error) => {
          const onMessage = (event: MessageEvent<CertifiedResponse<CertifiedRuntimeOutput>>) =>
            message(event.data);
          const onError = (event: ErrorEvent) => error(event.error ?? event.message);
          const onMessageError = () => error(new Error("Certified response could not be cloned."));
          worker.addEventListener("message", onMessage);
          worker.addEventListener("error", onError);
          worker.addEventListener("messageerror", onMessageError);
          return () => {
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            worker.removeEventListener("messageerror", onMessageError);
          };
        },
      };
      return port;
    },
  });
}
