import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./usage-guard/src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ENVIRONMENT: "staging",
          DEPLOY_SHA: "test-usage-guard-sha",
          CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
          CLOUDFLARE_D1_ANALYTICS_TOKEN: "analytics-token",
          CLOUDFLARE_BILLING_READ_TOKEN: "billing-token",
          DISCORD_BOT_TOKEN: "discord-token",
          DISCORD_ALERT_CHANNEL_ID: "123456789012345678",
          ADMIN_TOKEN: "test-admin-token",
        },
        d1Databases: ["GUARD_DB"],
      },
    }),
  ],
  test: {
    include: ["usage-guard/src/**/*.test.ts"],
  },
});
