import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { type PreviewServer, preview } from "vite";

const PORT = 4175;
let previewServer: PreviewServer | null = null;

test.beforeAll(async () => {
  previewServer = await preview({
    base: "./",
    configFile: false,
    preview: {
      host: "127.0.0.1",
      port: PORT,
      strictPort: true,
    },
    root: process.cwd(),
  });
});

test.afterAll(async () => {
  if (!previewServer) return;
  await new Promise<void>((resolve, reject) => {
    previewServer?.httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  previewServer = null;
});

async function accessibilityViolations(
  page: import("@playwright/test").Page,
  allowedViolationIds: ReadonlySet<string> = new Set(),
) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return result.violations.filter((violation) => !allowedViolationIds.has(violation.id));
}

test("desktop light application has no untracked WCAG A/AA violations", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/?demoStats=1`);
  await expect(page.locator(".app-shell")).toBeVisible();

  expect(await accessibilityViolations(page, new Set(["color-contrast"]))).toEqual([]);
});

test("mobile dark application has no WCAG A/AA violations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${PORT}/?demoStats=1`);
  await page
    .getByRole("group", { name: "테마 선택" })
    .getByRole("button", { name: "다크", exact: true })
    .click();
  await expect(page.locator("body")).toHaveClass(/theme-dark/);

  expect(await accessibilityViolations(page)).toEqual([]);
});
