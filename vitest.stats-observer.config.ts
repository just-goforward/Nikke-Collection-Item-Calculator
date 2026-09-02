import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./stats-observer/src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-22",
        bindings: {
          ENVIRONMENT: "staging",
          DEPLOY_SHA: "a".repeat(40),
          DISCORD_BOT_TOKEN: "test-discord-token",
          DISCORD_ALERT_CHANNEL_ID: "123456789012345678",
        },
        d1Databases: ["STATS_DB", "OBSERVER_DB", "GUARD_DB"],
      },
    }),
  ],
  test: {
    include: ["stats-observer/src/**/*.test.ts"],
  },
});

