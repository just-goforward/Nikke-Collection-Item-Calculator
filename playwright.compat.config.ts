import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /(?:accessibility|i18n)\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  projects: [
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        locale: "ko-KR",
        trace: "retain-on-failure",
      },
    },
  ],
});
