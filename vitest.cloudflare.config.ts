import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./cloudflare/src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-09",
        bindings: {
          ADMIN_TOKEN: "test-admin-token",
          ALLOWED_ORIGINS: "https://test.example",
          TURNSTILE_SECRET_KEY: "test-turnstile-secret",
        },
        d1Databases: ["DB", "USAGE_GUARD_DB"],
        ratelimits: {
          EVENT_RATE_LIMITER: {
            namespace_id: "419102",
            simple: { limit: 120, period: 60 },
          },
        },
      },
    }),
  ],
  test: {
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["vitest"],
        },
      },
    },
    include: ["cloudflare/src/**/*.test.ts"],
  },
});
