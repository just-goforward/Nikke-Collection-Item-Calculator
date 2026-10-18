import { defineConfig, devices } from "@playwright/test";

// T11: the spec starts its own Miniflare instance with seeded local D1; no network.
const viewports = [
  { label: "390", viewport: { width: 390, height: 844 } },
  { label: "1280", viewport: { width: 1280, height: 900 } },
];
const timezones = ["Asia/Seoul", "America/Los_Angeles"];

export default defineConfig({
  testDir: "../e2e",
  testMatch: "forecast-admin-calendar.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: "list",
  outputDir: "../test-results/forecast-admin",
  projects: timezones.flatMap((timezoneId) =>
    viewports.map(({ label, viewport }) => ({
      name: `chromium-${timezoneId.replace("/", "-")}-${label}`,
      use: { ...devices["Desktop Chrome"], viewport, timezoneId, locale: "ko-KR" },
    })),
  ),
});
