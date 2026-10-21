import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import { closePreviewServer, test } from "./test";

const PORT = 4286;
const ORIGIN = "https://nikkecollection.com";
const locales = [
  {
    lang: "ko",
    effective: "시행일: 2026년 10월 21일",
    prefix: "/",
    home: "NIKKE 소장품 레벨업 계산기",
    titles: { privacy: "개인정보 처리방침", terms: "서비스 이용약관", licenses: "라이선스" },
    links: ["개인정보 처리방침", "이용약관", "문의하기", "라이선스"],
    subject: "[NIKKE 계산기] 문의",
    rights: "비공식 팬 제작 계산기입니다. NIKKE 관련 권리는 각 권리자에게 있습니다.",
    logging: "(2026년 10월 28일 무렵 종료 예정)에는 일시적으로 모든 요청을 기록합니다",
  },
  {
    lang: "en",
    effective: "Effective date: October 21, 2026",
    prefix: "/en/",
    home: "NIKKE Collection Item Upgrade Calculator",
    titles: { privacy: "Privacy Policy", terms: "Terms of Service", licenses: "Licenses" },
    links: ["Privacy policy", "Terms of service", "Contact", "License"],
    subject: "[NIKKE Calculator] Inquiry",
    rights: "An unofficial fan-made calculator. NIKKE-related rights belong to their respective owners.",
    logging: "(expected to end around October 28, 2026), all requests are temporarily recorded",
  },
  {
    lang: "ja",
    effective: "施行日: 2026年10月21日",
    prefix: "/ja/",
    home: "NIKKE コレクション強化計算機",
    titles: { privacy: "プライバシーポリシー", terms: "サービス利用規約", licenses: "ライセンス" },
    links: ["プライバシーポリシー", "利用規約", "お問い合わせ", "ライセンス"],
    subject: "[NIKKE計算機] お問い合わせ",
    rights: "非公式のファン制作計算ツールです。NIKKE関連の権利は各権利者に帰属します。",
    logging: "(2026年10月28日ごろ終了予定)中は一時的にすべてのリクエストを記録します",
  },
] as const;
const pages = ["privacy", "terms", "licenses"] as const;

let previewServer: PreviewServer | null = null;

test.beforeAll(async () => {
  previewServer = await preview({
    base: "/",
    configFile: false,
    preview: { host: "127.0.0.1", port: PORT, strictPort: true },
    root: process.cwd(),
  });
});

test.afterAll(async () => {
  await closePreviewServer(previewServer);
  previewServer = null;
});

for (const locale of locales) {
  test(`${locale.lang} footer shows the four site links and the rights notice`, async ({
    page,
  }) => {
    await page.goto(`http://127.0.0.1:${PORT}${locale.prefix}?statsEnv=disabled`);
    const footer = page.locator("footer.privacy-footer");
    const links = footer.getByRole("link");
    await expect(links).toHaveText([...locale.links]);
    const hrefs = await links.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("href")),
    );
    expect(hrefs).toEqual([
      `${locale.prefix}privacy`,
      `${locale.prefix}terms`,
      `mailto:contact@nikkecollection.com?subject=${encodeURIComponent(locale.subject)}`,
      `${locale.prefix}licenses`,
    ]);
    await expect(footer.locator("p")).toHaveCount(1);
    await expect(footer.locator("p")).toContainText(locale.rights);
    await links.first().focus();
    await expect(links.first()).toBeFocused();
  });

  for (const legalPage of pages) {
    test(`${locale.prefix}${legalPage} is a static localized document`, async ({ browser }) => {
      const context = await browser.newContext({ javaScriptEnabled: false });
      const page = await context.newPage();
      const response = await page.goto(`http://127.0.0.1:${PORT}${locale.prefix}${legalPage}`);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-type"]).toContain("text/html");
      await expect(page.locator("html")).toHaveAttribute("lang", locale.lang);
      await expect(page).toHaveTitle(`${locale.titles[legalPage]} - ${locale.home}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(locale.titles[legalPage]);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        "href",
        `${ORIGIN}${locale.prefix}${legalPage}`,
      );
      const alternates = await page
        .locator('link[rel="alternate"]')
        .evaluateAll((links) =>
          links.map((link) => [link.getAttribute("hreflang"), link.getAttribute("href")]),
        );
      expect(alternates).toEqual([
        ["ko", `${ORIGIN}/${legalPage}`],
        ["en", `${ORIGIN}/en/${legalPage}`],
        ["ja", `${ORIGIN}/ja/${legalPage}`],
        ["x-default", `${ORIGIN}/${legalPage}`],
      ]);
      await expect(page.locator(".back a")).toHaveAttribute("href", locale.prefix);
      await expect(page.locator("mark.placeholder")).toHaveCount(0);
      if (legalPage !== "licenses") {
        await expect(page.locator("main")).toContainText(locale.effective);
      }
      if (legalPage === "privacy") {
        const contactLinks = page.getByRole("link", { name: "contact@nikkecollection.com" });
        await expect(contactLinks).toHaveCount(2);
        for (const link of await contactLinks.all()) {
          await expect(link).toHaveAttribute("href", "mailto:contact@nikkecollection.com");
        }
        await expect(page.locator("main")).toContainText(locale.logging);
      }
      if (legalPage === "terms") {
        const main = page.locator("main");
        await expect(main.locator(`a[href="${locale.prefix}privacy"]`)).toHaveCount(1);
        await expect(main.locator(`a[href="${locale.prefix}licenses"]`)).toHaveCount(1);
        await expect(main.locator('a[href="mailto:contact@nikkecollection.com"]')).toHaveCount(1);
      }
      await context.close();
    });
  }
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`ko /privacy has no WCAG A/AA violations (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto(`http://127.0.0.1:${PORT}/privacy`);
    const regions = page.getByRole("region", { name: "1. 처리하는 정보와 목적" });
    await expect(regions).toHaveAttribute("tabindex", "0");
    await regions.focus();
    await expect(regions).toBeFocused();
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });

  test(`ko /terms has no WCAG A/AA violations (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto(`http://127.0.0.1:${PORT}/terms`);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });
}

test("legal pages fit a 390px mobile viewport without page-level horizontal scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const legalPage of pages) {
    await page.goto(`http://127.0.0.1:${PORT}/${legalPage}`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});
