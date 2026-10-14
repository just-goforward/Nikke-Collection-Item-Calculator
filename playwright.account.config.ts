import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Account e2e (e2e/account*.spec.ts) on an isolated build: every run gets its own directory for
 * the build output, test results and traces, and playwright.account-setup.config.ts builds into it and
 * picks a free port. Concurrent `dist` rebuilds or other Playwright runs cannot affect it.
 * The directory is allocated once in the main process; workers inherit it through the environment.
 */
const artifacts = resolve(".artifacts");
mkdirSync(artifacts, { recursive: true });
process.env["ACCOUNT_E2E_RUN"] ??= mkdtempSync(join(artifacts, "account-e2e-"));
const run = process.env["ACCOUNT_E2E_RUN"];
process.env["ACCOUNT_E2E_DIST"] = join(run, "dist");

export default defineConfig({
  testDir: "./e2e",
  testMatch: /account(-recovery)?\.spec\.ts$/,
  globalSetup: "./playwright.account-setup.config.ts",
  outputDir: join(run, "test-results"),
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: 1,
  reporter: process.env["CI"] ? [["github"], ["list"]] : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    trace: "retain-on-failure",
    locale: "ko-KR",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
