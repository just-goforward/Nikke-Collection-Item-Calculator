import { resolve } from "node:path";

export function localWorkerOptions(root, script, temporaryPath, onOutbound = () => {}) {
  return {
    host: "127.0.0.1",
    port: 4290,
    cf: false,
    telemetry: { enabled: false },
    logRequests: false,
    unsafeLocalExplorer: false,
    unsafeObservability: false,
    unsafeRuntimeEnv: {},
    resourceTmpPath: temporaryPath,
    workers: [{
      config: {
        name: "operational-local-only",
        compatibilityDate: "2026-10-13",
        workersDev: false,
        previewUrls: false,
        observability: { enabled: false },
        manifest: {
          mainModule: "worker.js",
          modulesRoot: root,
          modules: { "worker.js": { type: "esm", contents: script } },
        },
        env: { SITE_ENV: { type: "text", value: "production" }, ASSETS: { type: "assets" } },
        assets: {
          directory: resolve(root, "dist"),
          hasUserWorker: true,
          notFoundHandling: "404-page",
          runWorkerFirst: true,
        },
      },
      dev: {
        rootPath: root,
        unsafeRegisterWorker: false,
        outboundService: {
          type: "fetcher",
          handler: () => { onOutbound(); throw new Error("OPERATIONAL_OUTBOUND_PROHIBITED"); },
        },
      },
    }],
  };
}
