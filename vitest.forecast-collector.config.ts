import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./forecast-collector/src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-14",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ADMIN_TOKEN: "test-forecast-admin-token",
          ENVIRONMENT: "test",
          DEPLOY_SHA: "test-deploy-sha",
          POLL_MODE: "both",
        },
        d1Databases: ["FORECAST_DB"],
      },
    }),
  ],
  test: {
    include: ["forecast-collector/src/**/*.test.ts"],
  },
});
