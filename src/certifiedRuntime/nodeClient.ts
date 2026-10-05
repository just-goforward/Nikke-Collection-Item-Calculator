import { Worker } from "node:worker_threads";
import type { CertifiedInput } from "../certified/types.ts";
import {
  assertTrustedCertifiedForecast,
  trustedCertifiedForecastWorkspaceBound,
} from "../lib/certifiedForecastTrust.ts";
import { type CertifiedWorkerPort, createCertifiedClient } from "./client.ts";
import { assertCertifiedOutputBinding, type CertifiedRuntimeOutput } from "./outputBinding.ts";
import { interruptedCertifiedWaiting } from "./partial.ts";

/** Node's worker URL must be an executable ESM bundle (or a TS-aware Node runtime). */
export function createNodeCertifiedClient(
  workerUrl: URL,
  options: { idleTimeoutMs?: number } = {},
) {
  return createCertifiedClient<CertifiedInput, CertifiedRuntimeOutput>({
    ...options,
    preservePartial: interruptedCertifiedWaiting,
    validateOutputBinding: assertCertifiedOutputBinding,
    bindForecastIdentity: (input, track) => assertTrustedCertifiedForecast(input.snapshot, track),
    forecastIdentityWorkspaceBound: (input) =>
      trustedCertifiedForecastWorkspaceBound(input.snapshot),
    createWorker: () => {
      const worker = new Worker(workerUrl);
      const port: CertifiedWorkerPort<CertifiedInput, CertifiedRuntimeOutput> = {
        runtime: "node",
        postMessage: (message) => worker.postMessage(message),
        terminate: () => worker.terminate(),
        listen: (message, error) => {
          const onExit = (code: number) => error(new Error(`Certified Worker exited (${code}).`));
          worker.on("message", message);
          worker.on("error", error);
          worker.on("messageerror", error);
          worker.on("exit", onExit);
          return () => {
            worker.off("message", message);
            worker.off("error", error);
            worker.off("messageerror", error);
            worker.off("exit", onExit);
          };
        },
      };
      return port;
    },
  });
}
