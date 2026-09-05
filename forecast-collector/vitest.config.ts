import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-14",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ADMIN_TOKEN: "test-forecast-admin-token",
          ENVIRONMENT: "test",
          DEPLOY_SHA: "test-deploy-sha",
          POLL_MODE: "both",
        },
        d1Databases: ["FORECAST_DB", "USAGE_GUARD_DB"],
      },
    }),
  ],
  test: {
    clearMocks: false,
    include: ["src/**/*.test.ts"],
  },
});
