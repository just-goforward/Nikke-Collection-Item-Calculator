import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-22",
        bindings: {
          PERSONAL_MIGRATIONS: await readD1Migrations(`${import.meta.dirname}/migrations/personal`),
          PRIVACY_MIGRATIONS: await readD1Migrations(`${import.meta.dirname}/migrations/privacy`),
          PUBLIC_MIGRATIONS: await readD1Migrations(`${import.meta.dirname}/migrations/public`),
        },
        d1Databases: ["PERSONAL_DB", "PRIVACY_CONTROL_DB", "PUBLIC_AGGREGATE_DB"],
      },
    }),
  ],
  test: {
    // Same existing workaround as stats-observer: workers-sdk#16163.
    fsModuleCache: false,
    include: ["src/**/*.test.ts"],
  },
});
