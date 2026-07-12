import { expect, type Page, test } from "@playwright/test";
import { type PreviewServer, preview } from "vite";

const PORT = 4277;
const LANGUAGE_STORAGE_KEY = "collection-kit-calculator.language";
let previewServer: PreviewServer | null = null;

async function prepareLocale(page: Page, languages: string[], savedLocale?: "ko" | "en" | "ja") {
  await page.addInitScript(
    ({ languageStorageKey, navigatorLanguages, storedLocale }) => {
      const seedKey = `${languageStorageKey}.test-seeded`;
      if (!sessionStorage.getItem(seedKey)) {
        if (storedLocale) localStorage.setItem(languageStorageKey, storedLocale);
        else localStorage.removeItem(languageStorageKey);
        sessionStorage.setItem(seedKey, "1");
      }
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        get: () => navigatorLanguages,
      });
      Object.defineProperty(navigator, "language", {
        configurable: true,
        get: () => navigatorLanguages[0] ?? "ko-KR",
      });
    },
    {
      languageStorageKey: LANGUAGE_STORAGE_KEY,
      navigatorLanguages: languages,
      storedLocale: savedLocale,
    },
  );
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
}

async function clickVisibleTab(page: Page, name: string) {
  const tabs = page.getByRole("tab", { name });
  for (let index = 0; index < (await tabs.count()); index += 1) {
    const tab = tabs.nth(index);
    if (!(await tab.isVisible())) continue;
    await tab.click();
    return;
  }
  throw new Error(`No visible tab named ${name}.`);
}

test.beforeAll(async () => {
  previewServer = await preview({
    base: "./",
    configFile: false,
    preview: { host: "127.0.0.1", port: PORT, strictPort: true },
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

test.beforeEach(async ({ page }) => {
  await page.route("https://cdn.jsdelivr.net/**", (route) =>
    route.fulfill({ body: "", contentType: "text/css", status: 200 }),
  );
});

test("browser language selects Japanese and its font before app use", async ({ page }) => {
  await prepareLocale(page, ["ja-JP", "en-US"]);
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);

  const html = page.locator("html");
  await expect(html).toHaveAttribute("lang", "ja");
  await expect(html).toHaveAttribute("data-locale", "ja");
  await expect(page).toHaveTitle("コレクション強化計算機");
  await expect(page.getByRole("heading", { name: "コレクション強化計算機" })).toBeVisible();
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /お手入れキット/,
  );
  await expect(page.locator("#locale-font-stylesheet")).toHaveAttribute(
    "href",
    /pretendardvariable-jp-dynamic-subset\.min\.css$/,
  );
  await expect
    .poll(() => page.locator("body").evaluate((body) => getComputedStyle(body).fontFamily))
    .toContain("Pretendard JP Variable");
});

test("saved language overrides the browser language and persists after reload", async ({
  page,
}) => {
  await prepareLocale(page, ["ja-JP"], "en");
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("heading", { name: "Collection Item Upgrade Calculator" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Select language" }).click();
  await page.getByRole("option", { name: "日本語" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), LANGUAGE_STORAGE_KEY))
    .toBe("ja");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("heading", { name: "コレクション強化計算機" })).toBeVisible();
});

test("an existing calculation result switches language without recalculation", async ({ page }) => {
  await prepareLocale(page, ["en-US"]);
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await page.locator('[data-grade="SR"]').click();
  await page.locator('[data-level="10"]').click();
  await page.locator("#yellowStock").fill("100");
  await page.locator("#calculateButton").click();
  await expect(page.getByText("Chance to reach SR 15").first()).toBeVisible({ timeout: 20_000 });
  const actionCount = Number(
    (await page.locator(".next-action .action-chip-count").first().textContent())?.match(
      /\d+/,
    )?.[0],
  );
  expect(actionCount).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Select language" }).click();
  await page.getByRole("option", { name: "日本語" }).click();

  await expect(page.getByText("SR15到達率").first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "候補" })).toBeVisible();
  await expect(page.locator(".next-action .action-chip-name").first()).toContainText(
    "上級者用お手入れキット",
  );
  await expect(page.locator(".next-action .action-chip-count").first()).toContainText(
    String(actionCount),
  );
});

test("English and Japanese layouts do not overflow common phone, tablet, and desktop widths", async ({
  page,
}) => {
  await prepareLocale(page, ["en-US"]);
  for (const locale of ["en", "ja"] as const) {
    await page.goto(`http://127.0.0.1:${PORT}/?demoStats=1`);
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: LANGUAGE_STORAGE_KEY,
      value: locale,
    });
    await page.reload();
    for (const width of [320, 390, 768, 1365]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalOverflow(page);
      const statsLabel = locale === "en" ? "Stats" : "統計";
      await clickVisibleTab(page, statsLabel);
      await page
        .getByText(locale === "en" ? "Overall Super Success Rate" : "全体大成功率", {
          exact: true,
        })
        .waitFor({ state: "visible" });
      await expectNoHorizontalOverflow(page);
      const clippedSectionText = await page
        .locator(".stats-section-title > *")
        .evaluateAll((nodes) =>
          nodes
            .filter((node) => node.scrollWidth > node.clientWidth + 1)
            .map((node) => node.textContent),
        );
      expect(clippedSectionText).toEqual([]);
    }
  }
});
