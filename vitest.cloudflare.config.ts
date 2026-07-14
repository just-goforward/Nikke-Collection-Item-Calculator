import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./cloudflare/src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-05-05",
        bindings: {
          ADMIN_TOKEN: "test-admin-token",
          ALLOWED_ORIGINS: "https://test.example",
          RATE_LIMIT_SECRET: "test-rate-limit-secret",
          TURNSTILE_SECRET_KEY: "test-turnstile-secret",
        },
        d1Databases: ["DB"],
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
