import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import { test } from "./test";

const PORT = 4175;
let previewServer: PreviewServer | null = null;

async function setTheme(page: import("@playwright/test").Page, theme: "light" | "dark") {
  const label = theme === "dark" ? "다크" : "라이트";
  const desktopButton = page.locator(`button[data-theme-mode="${theme}"]`).first();
  if (await desktopButton.isVisible()) {
    await desktopButton.click();
    return;
  }
  await page.getByRole("button", { name: /테마 선택/ }).click();
  await page
    .getByRole("listbox", { name: "테마 선택" })
    .getByRole("option", { name: label })
    .click();
}

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

test("데스크톱 라이트 화면에는 추적되지 않은 WCAG A/AA 위반이 없다", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/?demoStats=1`);
  await expect(page.locator(".app-shell")).toBeVisible();

  expect(await accessibilityViolations(page)).toEqual([]);
});

test("모바일 다크 화면에는 WCAG A/AA 위반이 없다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${PORT}/?demoStats=1`);
  await setTheme(page, "dark");
  await expect(page.locator("body")).toHaveClass(/theme-dark/);

  expect(await accessibilityViolations(page)).toEqual([]);
});

test("English desktop UI has no untracked WCAG A/AA violations", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("collection-kit-calculator.language", "en");
  });
  await page.goto(`http://127.0.0.1:${PORT}/?demoStats=1`);
  await expect(
    page.getByRole("heading", { name: "Collection Item Upgrade Calculator" }),
  ).toBeVisible();

  expect(await accessibilityViolations(page)).toEqual([]);
});

test("Japanese mobile UI has no untracked WCAG A/AA violations", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("collection-kit-calculator.language", "ja");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${PORT}/?demoStats=1`);
  await expect(page.getByRole("heading", { name: "コレクション強化計算機" })).toBeVisible();

  expect(await accessibilityViolations(page)).toEqual([]);
});
