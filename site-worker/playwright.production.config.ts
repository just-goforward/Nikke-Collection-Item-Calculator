import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "production.smoke.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: "../test-results/site-production",
  use: { baseURL: "http://127.0.0.1:4290", locale: "ko-KR" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command:
      "node scripts/build-site-production.ts --check && npx wrangler dev --local --config site-worker/production.wrangler.toml --ip 127.0.0.1 --port 4290",
    cwd: "..",
    url: "http://127.0.0.1:4290",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
