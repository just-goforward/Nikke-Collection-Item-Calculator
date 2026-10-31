import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-22",
        bindings: {
          ACCESS_TEAM_DOMAIN: "https://example-team.cloudflareaccess.com",
          ACCESS_AUD: "a".repeat(64),
          // Placeholder only; the real allow-list is deploy configuration.
          ADMIN_ALLOWED_EMAILS: "admin@example.com",
        },
        d1Databases: ["FORECAST_DB", "USAGE_GUARD_DB"],
        ratelimits: {
          ADMIN_IP_RATE_LIMITER: { namespace_id: "419108", simple: { limit: 1000, period: 60 } },
          ADMIN_IDENTITY_RATE_LIMITER: {
            namespace_id: "419109",
            simple: { limit: 1000, period: 60 },
          },
        },
      },
    }),
  ],
  test: {
    // Temporary: workerd cannot read Vitest 5 fsModuleCache entries; remove when cloudflare/workers-sdk#16163 ships
    fsModuleCache: false,
    clearMocks: false,
    include: ["src/**/*.test.ts"],
  },
});
