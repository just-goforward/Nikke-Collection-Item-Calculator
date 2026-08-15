import { expect, type Page } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import { test } from "./test";

const PORT = 4278;
const LANGUAGE_STORAGE_KEY = "collection-kit-calculator.language";
const localePages = [
  {
    canonical: "https://nikkecollection.com/",
    description: /키트 사용 순서/,
    font: /pretendardvariable-dynamic-subset\.min\.css$/,
    lang: "ko",
    ogLocale: "ko_KR",
    path: "/",
    title: "NIKKE 소장품 레벨업 계산기",
  },
  {
    canonical: "https://nikkecollection.com/en/",
    description: /Maintenance Kit order/,
    font: /pretendardvariable-std-dynamic-subset\.min\.css$/,
    lang: "en",
    ogLocale: "en_US",
    path: "/en/",
    title: "NIKKE Collection Item Upgrade Calculator",
  },
  {
    canonical: "https://nikkecollection.com/ja/",
    description: /お手入れキット/,
    font: /pretendardvariable-jp-dynamic-subset\.min\.css$/,
    lang: "ja",
    ogLocale: "ja_JP",
    path: "/ja/",
    title: "NIKKE コレクション強化計算機",
  },
] as const;

let previewServer: PreviewServer | null = null;

async function prepareBrowser(page: Page, languages: string[], savedLocale?: "ko" | "en" | "ja") {
  await page.addInitScript(
    ({ languageStorageKey, navigatorLanguages, storedLocale }) => {
      const seedKey = `${languageStorageKey}.localized-pages-seeded`;
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

test.beforeAll(async () => {
  previewServer = await preview({
    base: "/",
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

for (const locale of localePages) {
  test(`${locale.lang} URL exposes its independent localized search document`, async ({ page }) => {
    await prepareBrowser(page, ["en-US", "ja-JP"]);
    await page.goto(`http://127.0.0.1:${PORT}${locale.path}?statsEnv=disabled`);

    const html = page.locator("html");
    await expect(html).toHaveAttribute("lang", locale.lang);
    await expect(html).toHaveAttribute("data-locale", locale.lang);
    await expect(page).toHaveTitle(locale.title);
    await expect(page.getByRole("heading", { name: locale.title })).toBeVisible();
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      locale.description,
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", locale.canonical);
    await expect
      .poll(() =>
        page.locator('link[rel="alternate"]').evaluateAll((links) =>
          links.map((link) => ({
            href: link.getAttribute("href"),
            hreflang: link.getAttribute("hreflang"),
          })),
        ),
      )
      .toEqual([
        { href: "https://nikkecollection.com/", hreflang: "ko" },
        { href: "https://nikkecollection.com/en/", hreflang: "en" },
        { href: "https://nikkecollection.com/ja/", hreflang: "ja" },
        { href: "https://nikkecollection.com/", hreflang: "x-default" },
      ]);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      "content",
      locale.canonical,
    );
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute(
      "content",
      locale.ogLocale,
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      `https://nikkecollection.com/og/collection-calculator-${locale.lang}.png`,
    );
    await expect(page.locator("#locale-font-stylesheet")).toHaveAttribute("href", locale.font);
    const structuredData = await page
      .locator("#site-structured-data")
      .evaluate((script) => JSON.parse(script.textContent ?? "null"));
    expect(structuredData).toMatchObject({
      "@type": "SoftwareApplication",
      inLanguage: locale.lang,
      name: locale.title,
      url: locale.canonical,
    });
  });
}

test("language menu entries remain crawlable links", async ({ page }) => {
  await prepareBrowser(page, ["en-US", "ja-JP"]);
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);

  await expect(page).toHaveURL(/\/\?statsEnv=disabled$/);
  await expect(page).toHaveTitle("NIKKE 소장품 레벨업 계산기");
  await page.getByRole("button", { name: "언어 선택" }).click();
  await expect(page.getByRole("menuitemradio", { name: "English" })).toHaveAttribute(
    "href",
    "/en/",
  );
  await expect(page.getByRole("menuitemradio", { name: "日本語" })).toHaveAttribute("href", "/ja/");
});

test("a legacy saved language migrates once to its URL", async ({ page }) => {
  await prepareBrowser(page, ["ja-JP"], "en");
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page).toHaveURL(/\/en\/\?statsEnv=disabled$/);
  await expect(
    page.getByRole("heading", { name: "NIKKE Collection Item Upgrade Calculator" }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), LANGUAGE_STORAGE_KEY))
    .toBeNull();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("an explicit locale URL overrides and clears a legacy saved language", async ({ page }) => {
  await prepareBrowser(page, ["ko-KR"], "en");
  await page.goto(`http://127.0.0.1:${PORT}/ja/?statsEnv=disabled`);

  await expect(page).toHaveURL(/\/ja\/\?statsEnv=disabled$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), LANGUAGE_STORAGE_KEY))
    .toBeNull();
});
