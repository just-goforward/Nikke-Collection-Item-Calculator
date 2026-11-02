import { defineConfig } from "@playwright/test";
import { privateDirectory } from "./e2e/operational-report.mjs";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "decision-analytics.spec.ts",
  workers: 1,
  retries: 0,
  repeatEach: 1,
  fullyParallel: false,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: privateDirectory("analytics-policy-artifacts"),
  reporter: [["./e2e/operational-playwright-reporter.ts", { suiteId: "analytics-policy" }]],
  use: {
    browserName: "chromium",
    headless: true,
    launchOptions: { chromiumSandbox: true },
    serviceWorkers: "block",
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  projects: [{ name: "chromium" }],
});
