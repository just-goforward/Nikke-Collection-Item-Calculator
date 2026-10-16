import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "../e2e",
  testMatch: "runtime-forecast.spec.ts",
  workers: 1,
  timeout: 30_000,
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
    { name: "firefox", use: devices["Desktop Firefox"] },
    { name: "webkit", use: devices["Desktop Safari"] },
  ],
});
