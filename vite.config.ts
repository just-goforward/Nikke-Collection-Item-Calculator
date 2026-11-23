import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import {
  certifiedBundleBoundaryPlugin,
  certifiedWorkerWhitespacePlugin,
  workerChunkGraphPlugin,
} from "./scripts/certified-bundle-boundary.ts";
import { certifiedEngineBuildGuardPlugin } from "./scripts/certified-engine-build.ts";
import { forecastRuntimeBuildPlugin } from "./scripts/forecast-runtime-build.ts";
import { serviceH14BuildGuardPlugin } from "./scripts/service-h14-integrity.ts";

import { localizedPagesPlugin } from "./scripts/localized-pages.ts";
import { STATS_DELIVERY_HEALTH_EMIT_ENABLED } from "./shared/solverRecoveryContract.ts";
import previewTrust from "./preview-gateway/trust.json" with { type: "json" };
import legacy from "./site-worker/production-forecast.proposed.json" with { type: "json" };

export default defineConfig({
  ...(process.env["SOLVER_A_VITE_CACHE_DIR"]
    ? { cacheDir: process.env["SOLVER_A_VITE_CACHE_DIR"] }
    : {}),
  base: "/preview/",
  define: {
    __ISOLATED_ROOT_CANDIDATE__: "false",
    __APP_REVISION__: JSON.stringify(process.env["GITHUB_SHA"] ?? "local"),
    __STATS_DELIVERY_HEALTH_EMIT_ENABLED__: JSON.stringify(STATS_DELIVERY_HEALTH_EMIT_ENABLED),
  },
  plugins: [
    {
      name: "preview-only-trust",
      configResolved({ base, env }) {
        if (base !== "/preview/" || env["VITE_SERVICE_CERTIFIED_SOLVER"] !== "true" ||
            env["VITE_FORECAST_RUNTIME"] !== previewTrust.environment ||
            env["VITE_PREVIEW_LEGACY_D0"] !== "true" || env["VITE_FORECAST_PUBLIC_KEY_ID"] !== legacy.keyId ||
            env["VITE_FORECAST_PUBLIC_KEY_BASE64"] !== legacy.publicKeyBase64 ||
            env["VITE_FORECAST_TIMED_V1_PUBLIC_KEY_ID"] !== previewTrust.keyId ||
            env["VITE_FORECAST_TIMED_V1_PUBLIC_KEY_BASE64"] !== previewTrust.publicKeyBase64)
          throw new Error("preview_only_configuration_required");
      },
    },
    certifiedEngineBuildGuardPlugin(),
    forecastRuntimeBuildPlugin(),
    serviceH14BuildGuardPlugin(),
    localizedPagesPlugin(),
    react(),
    tailwindcss(),
    certifiedBundleBoundaryPlugin(),
  ],
  // Dev-only: the repository holds very large non-app trees; keep the watcher and the dependency
  // scan on the app entry so `pnpm run dev` responds promptly. Builds are unaffected.
  server: {
    watch: {
      ignored: [
        "**/benchmarks/**",
        "**/.tmp/**",
        "**/.certified-*/**",
        "**/.local-research-assets/**",
        "**/.artifacts/**",
        "**/rust/**/target/**",
      ],
    },
  },
  optimizeDeps: { entries: ["index.html"] },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    manifest: true,
    license: { fileName: "third-party-licenses.md" },
    target: "es2022",
    minify: "oxc",
    cssMinify: true,
    sourcemap: false,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, "/");
          if (normalizedId.includes("/node_modules/react")) return "react";
          return undefined;
        },
      },
    },
  },
  worker: {
    format: "es",
    plugins: () => [certifiedWorkerWhitespacePlugin(), workerChunkGraphPlugin()],
  },
});
