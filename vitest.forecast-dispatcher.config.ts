import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./forecast-dispatcher/src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ENVIRONMENT: "staging",
          DEPLOY_SHA: "test-dispatcher-sha",
          GITHUB_APP_ID: "123456",
          GITHUB_APP_INSTALLATION_ID: "789012",
          GITHUB_APP_PRIVATE_KEY: "test-private-key",
          DISCORD_BOT_TOKEN: "test-discord-token",
          DISCORD_CHANNEL_ID: "123456789012345678",
          DISPATCH_ENABLED: "true",
        },
        d1Databases: ["FORECAST_DB", "USAGE_GUARD_DB"],
      },
    }),
  ],
  test: {
    include: ["forecast-dispatcher/src/**/*.test.ts"],
  },
});
