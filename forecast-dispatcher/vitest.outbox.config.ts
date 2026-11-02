import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ENVIRONMENT: "staging",
          DEPLOY_SHA: "test-dispatcher-sha",
          DISCORD_BOT_TOKEN: "test-discord-token",
          DISCORD_CHANNEL_ID: "123456789012345678",
          DISCORD_ACTIVITY_CHANNEL_ID: "222222222222222222",
          DISCORD_ALERT_CHANNEL_ID: "333333333333333333",
          DISPATCH_ENABLED: "true",
          PUBLICATION_MODE: "enabled",
          DISCORD_APPROVAL_CHANNEL_ID: "123456789012345678",
        },
        d1Databases: ["FORECAST_DB", "USAGE_GUARD_DB"],
        outboundService: { name: "outbox-deny" },
        workers: [
          {
            name: "outbox-deny",
            compatibilityDate: "2026-08-22",
            modules: [
              {
                type: "ESModule",
                path: "outbox-deny.mjs",
                contents: `export default {
                  fetch() {
                    return new Response("OUTBOX_NETWORK_DENIED", { status: 403 });
                  },
                };`,
              },
            ],
          },
        ],
      },
    }),
  ],
  test: {
    // Temporary: workerd cannot read Vitest 5 fsModuleCache entries; remove when cloudflare/workers-sdk#16163 ships
    fsModuleCache: false,
    clearMocks: false,
    include: ["src/v2-outbox.integration.test.ts"],
  },
});
