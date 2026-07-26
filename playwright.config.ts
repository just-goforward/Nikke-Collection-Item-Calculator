import { defineConfig, devices } from "@playwright/test";

const smokePort = Number(process.env["E2E_SMOKE_PORT"] ?? 4273);

export default defineConfig({
  testDir: "./e2e",
  testIgnore: /alignment\.spec\.ts$/,
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: 1,
  reporter: process.env["CI"] ? [["github"], ["list"]] : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${smokePort}`,
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
