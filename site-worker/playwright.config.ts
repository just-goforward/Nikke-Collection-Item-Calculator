import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "smoke.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: "../test-results/site-staging",
  use: {
    baseURL: "http://127.0.0.1:4289",
    locale: "ko-KR",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Root config is binding-free: smoke never connects to provisioned staging services.
    command:
      "npx wrangler dev --local --config site-worker/wrangler.toml --ip 127.0.0.1 --port 4289",
    cwd: "..",
    url: "http://127.0.0.1:4289",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
