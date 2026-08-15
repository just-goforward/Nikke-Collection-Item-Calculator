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
    .getByRole("menu", { name: "테마 선택" })
    .getByRole("menuitemradio", { name: label })
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

async function calculateSr(
  page: import("@playwright/test").Page,
  level: number,
  stock: { blue?: string; purple?: string; yellow?: string },
) {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: `${level}단계`, exact: true }).click();
  if (stock.blue) await page.getByLabel("초심자용 키트").fill(stock.blue);
  if (stock.purple) await page.getByLabel("중급자용 키트").fill(stock.purple);
  if (stock.yellow) await page.getByLabel("상급자용 키트").fill(stock.yellow);
  const desktopCalculate = page.getByRole("button", { name: "계산", exact: true });
  if (await desktopCalculate.isVisible()) {
    await desktopCalculate.click();
  } else {
    await page
      .getByRole("toolbar", { name: "모바일 작업" })
      .getByRole("button", { name: "계산하기", exact: true })
      .click();
  }
  await expect(page.locator(".next-action")).toBeVisible({ timeout: 20_000 });
}

async function confirmGreatSuccess(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "대성공 O", exact: true }).first().click();
  await page.getByRole("button", { name: "대성공 O 확정", exact: true }).first().click();
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
  await page.goto(`http://127.0.0.1:${PORT}/en/?demoStats=1`);
  await expect(
    page.getByRole("heading", { name: "NIKKE Collection Item Upgrade Calculator" }),
  ).toBeVisible();

  expect(await accessibilityViolations(page)).toEqual([]);
});

test("Japanese mobile UI has no untracked WCAG A/AA violations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${PORT}/ja/?demoStats=1`);
  await expect(page.getByRole("heading", { name: "NIKKE コレクション強化計算機" })).toBeVisible();

  expect(await accessibilityViolations(page)).toEqual([]);
});

test("등급과 단계 버튼은 방향키로 선택과 포커스를 같이 이동한다", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);

  const gradeGroup = page.getByRole("group", { name: "소장품 등급" });
  const rank = gradeGroup.getByRole("button", { name: "R", exact: true });
  const superRare = gradeGroup.getByRole("button", { name: "SR", exact: true });
  await rank.focus();
  await page.keyboard.press("ArrowRight");
  await expect(superRare).toBeFocused();
  await expect(superRare).toHaveAttribute("aria-pressed", "true");

  const levelGroup = page.getByRole("group", { name: "현재 단계" });
  const level0 = levelGroup.getByRole("button", { name: "0단계", exact: true });
  const level1 = levelGroup.getByRole("button", { name: "1단계", exact: true });
  await level0.focus();
  await page.keyboard.press("ArrowRight");
  await expect(level1).toBeFocused();
  await expect(level1).toHaveAttribute("aria-pressed", "true");
});

test("계산 결과와 키트 수정 상태에는 추적되지 않은 WCAG A/AA 위반이 없다", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await calculateSr(page, 10, { yellow: "100" });
  expect(await accessibilityViolations(page)).toEqual([]);

  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await calculateSr(page, 5, { yellow: "100" });
  await confirmGreatSuccess(page);
  await expect(page.locator("#stockEditNotice")).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
});

test("대성공 회차 모달은 배경을 차단하고 접근 가능한 설명과 포커스를 유지한다", async ({
  page,
}) => {
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await calculateSr(page, 14, { blue: "100", purple: "20", yellow: "20" });
  const outcomeButton = page.getByRole("button", { name: "대성공 O", exact: true }).first();
  await outcomeButton.click();
  await page.getByRole("button", { name: "대성공 O 확정", exact: true }).first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-describedby", "attemptModalDescription");
  await expect(page.locator(".app-shell")).toHaveAttribute("inert", "");
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await expect(dialog.getByRole("button").first()).toBeFocused();
  expect(await accessibilityViolations(page)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".app-shell")).not.toHaveAttribute("inert", "");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const active = document.activeElement;
        return (
          active instanceof HTMLElement && active.offsetParent !== null && active.matches("button")
        );
      }),
    )
    .toBe(true);
});

test("강제 색상과 200% 확대 상당 폭에서도 결과 화면이 재배치되고 접근 가능하다", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.setViewportSize({ width: 640, height: 450 });
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await calculateSr(page, 10, { yellow: "100" });

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
  expect(await accessibilityViolations(page)).toEqual([]);
});
