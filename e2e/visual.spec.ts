import { expect, type Locator, type Page, test } from "@playwright/test";
import { type PreviewServer, preview } from "vite";

const PORT = 4174;
let previewServer: PreviewServer | null = null;
const THEME_LABELS = {
  dark: "다크",
  light: "라이트",
} as const;

async function waitForStableUi(page: import("@playwright/test").Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".app-shell").waitFor({ state: "visible" });
}

async function openDemo(page: import("@playwright/test").Page) {
  await page.goto(`http://127.0.0.1:${PORT}/?demoStats=1`);
  await waitForStableUi(page);
}

async function openStatsPanel(page: Page) {
  const globalStatsBox = page.locator("#globalStatsBox");
  if (!(await globalStatsBox.isVisible().catch(() => false))) {
    const desktopStatsTab = page.getByRole("tab", { name: "통계" }).first();
    if ((await desktopStatsTab.count()) > 0 && (await desktopStatsTab.isVisible())) {
      await desktopStatsTab.click();
    }
  }
  await expect(globalStatsBox).toBeVisible();
  await expect(page.locator("#globalStatsPanel .difficulty-list")).toBeVisible();
}

async function confirmOutcome(page: Page, locator: Locator, outcome: "대성공 O" | "대성공 X") {
  await locator.click();
  await page
    .getByRole("button", { name: `${outcome} 확정`, exact: true })
    .first()
    .click();
}

async function setTheme(page: import("@playwright/test").Page, theme: "light" | "dark") {
  const desktopButton = page.locator(`button[data-theme-mode="${theme}"]`).first();
  if (await desktopButton.isVisible()) {
    await desktopButton.click();
  } else {
    await page.getByRole("button", { name: /테마 선택/ }).click();
    await page
      .getByRole("listbox", { name: "테마 선택" })
      .getByRole("option", { name: THEME_LABELS[theme] })
      .click();
  }
  await expect(page.locator("body")).toHaveClass(new RegExp(`theme-${theme}`));
  await expect(page.locator("html")).not.toHaveClass(/theme-view-transitioning/);
}

async function setGrade(page: import("@playwright/test").Page, grade: "R" | "SR") {
  await page.getByRole("button", { exact: true, name: grade }).click();
  await expect(page.locator("body")).toHaveClass(new RegExp(`grade-${grade.toLowerCase()}`));
}

async function setLevel(page: import("@playwright/test").Page, level: number) {
  await page.locator(`button[data-level="${level}"]`).click();
}

async function fillStock(
  page: import("@playwright/test").Page,
  kit: "blue" | "purple" | "yellow",
  value: number,
) {
  await page.locator(`#${kit}Stock`).fill(String(value));
  await page.locator(`#${kit}Stock`).blur();
}

async function calculate(page: import("@playwright/test").Page) {
  await page.locator("#calculateButton").click();
  await expect(page.locator(".next-action")).toBeVisible({ timeout: 20_000 });
}

async function expectDesignSnapshot(page: import("@playwright/test").Page, name: string) {
  await expect(page).toHaveScreenshot(name, {
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    maxDiffPixelRatio: 0.01,
  });
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

test("데스크톱 라이트 R 디자인 기준", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1365 });
  await openDemo(page);
  await setTheme(page, "light");
  await setGrade(page, "R");

  await expectDesignSnapshot(page, "desktop-light-r.png");
});

test("데스크톱 다크 SR 디자인 기준", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1365 });
  await openDemo(page);
  await setTheme(page, "dark");
  await setGrade(page, "SR");

  await expectDesignSnapshot(page, "desktop-dark-sr.png");
});

test("모바일 라이트 R 입력 기준", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await openDemo(page);
  await setTheme(page, "light");
  await setGrade(page, "R");

  await expectDesignSnapshot(page, "mobile-light-r-input.png");
});

test("모바일 다크 SR 통계 기준", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await openDemo(page);
  await setTheme(page, "dark");
  await setGrade(page, "SR");
  await page.getByRole("tab").last().click();
  await openStatsPanel(page);

  await expectDesignSnapshot(page, "mobile-dark-sr-stats.png");
});

test("모바일 다크 SR 구간 툴팁 기준", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await openDemo(page);
  await setTheme(page, "dark");
  await setGrade(page, "SR");
  await page.getByRole("tab").last().click();
  await openStatsPanel(page);
  await page.locator(".difficulty-list .difficulty-interval").first().hover();
  await expect(page.locator(".difficulty-tooltip")).toHaveClass(/is-visible/);

  await expectDesignSnapshot(page, "mobile-dark-sr-interval-tooltip.png");
});

test("데스크톱 라이트 SR 결과 기준", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1365 });
  await openDemo(page);
  await setTheme(page, "light");
  await setGrade(page, "SR");
  await setLevel(page, 10);
  await fillStock(page, "yellow", 100);
  await calculate(page);

  await expectDesignSnapshot(page, "desktop-light-sr-result.png");
});

test("데스크톱 라이트 SR 대성공 키트 수정 기준", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1365 });
  await openDemo(page);
  await setTheme(page, "light");
  await setGrade(page, "SR");
  await setLevel(page, 5);
  await fillStock(page, "yellow", 100);
  await calculate(page);
  await confirmOutcome(page, page.locator(".success-button").first(), "대성공 O");
  await expect(page.locator("#stockEditNotice")).toBeVisible({ timeout: 10_000 });

  await expectDesignSnapshot(page, "desktop-light-sr-success-modal.png");
});

test("모바일 다크 R 결과 기준", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await openDemo(page);
  await setTheme(page, "dark");
  await setGrade(page, "R");
  await fillStock(page, "blue", 100);
  await page.locator(".mobile-action-bar .primary-button").click();
  await expect(page.locator(".next-action")).toBeVisible({ timeout: 20_000 });

  await expectDesignSnapshot(page, "mobile-dark-r-result.png");
});
