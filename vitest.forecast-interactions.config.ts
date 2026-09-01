import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./forecast-interactions/src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          DISCORD_PUBLIC_KEY: "unset",
          DISCORD_APPLICATION_ID: "123456789",
          DISCORD_GUILD_ID: "222222222",
          DISCORD_APPROVER_USER_ID: "987654321",
          DISCORD_APPROVAL_CHANNEL_ID: "333333333",
          DISCORD_ALERT_CHANNEL_ID: "444444444",
          DISCORD_ACTIVITY_CHANNEL_ID: "555555555",
          DEPLOY_SHA: "test-router-sha",
          PRODUCTION_MUTATIONS_ENABLED: "false",
        },
        d1Databases: ["STAGING_FORECAST_DB", "PRODUCTION_FORECAST_DB"],
      },
    }),
  ],
  test: {
    include: ["forecast-interactions/src/**/*.test.ts"],
  },
});
