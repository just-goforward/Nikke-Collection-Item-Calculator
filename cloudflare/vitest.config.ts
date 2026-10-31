import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-09",
        bindings: {
          ADMIN_TOKEN: "test-admin-token",
          ALLOWED_ORIGINS: "https://test.example",
          TURNSTILE_SECRET_KEY: "test-turnstile-secret",
          TURNSTILE_ALLOWED_HOSTNAMES: "test.example",
        },
        d1Databases: ["DB", "USAGE_GUARD_DB"],
        ratelimits: {
          READ_RATE_LIMITER: {
            namespace_id: "419104",
            simple: { limit: 120, period: 60 },
          },
          EVENT_RATE_LIMITER: {
            namespace_id: "419102",
            simple: { limit: 120, period: 60 },
          },
        },
      },
    }),
  ],
  test: {
    // Temporary: workerd cannot read Vitest 5 fsModuleCache entries; remove when cloudflare/workers-sdk#16163 ships
    fsModuleCache: false,
    clearMocks: false,
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["vitest"],
        },
      },
    },
    include: ["src/**/*.test.ts"],
  },
});
