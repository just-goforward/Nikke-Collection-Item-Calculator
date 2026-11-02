import { defineConfig } from "@playwright/test";
import { privateDirectory } from "./e2e/operational-report.mjs";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "operational-production.spec.ts",
  workers: 1,
  retries: 0,
  repeatEach: 1,
  fullyParallel: false,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: privateDirectory("production-policy-artifacts"),
  reporter: [["./e2e/operational-playwright-reporter.ts", { suiteId: "production-policy" }]],
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:4290",
    headless: true,
    launchOptions: { chromiumSandbox: true },
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    serviceWorkers: "block",
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: `"${process.execPath}" e2e/operational-server.mjs`,
    url: "http://127.0.0.1:4290",
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
