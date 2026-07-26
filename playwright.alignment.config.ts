import { defineConfig } from "@playwright/test";

const deviceScaleFactors = process.env["FULL_ALIGNMENT_MATRIX"] === "1" ? [1, 2, 3] : [1, 2];

const browserProjects = (["chromium", "firefox", "webkit"] as const).flatMap((browserName) =>
  deviceScaleFactors.map((deviceScaleFactor) => ({
    name: `${browserName}-dpr${deviceScaleFactor}`,
    use: { browserName, deviceScaleFactor },
  })),
);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /alignment\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,
  reporter: process.env["CI"] ? [["github"], ["list"]] : "list",
  timeout: 180_000,
  expect: { timeout: 12_000 },
  use: {
    baseURL: "http://127.0.0.1:4377",
    locale: "ko-KR",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 900 },
  },
  projects: browserProjects,
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4377 --strictPort",
    port: 4377,
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
  },
});
