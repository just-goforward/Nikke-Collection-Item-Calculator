import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  SITE_LOCALE_ORDER,
  SITE_LOCALES,
  siteLocaleFromPathname,
  siteLocaleUrl,
} from "../shared/siteLocales";
import { renderLocalizedPage, renderSitemap } from "./localized-pages";

const HTML_FIXTURE = `<!doctype html>
<html lang="ko" data-locale="ko" data-site-locale-root>
  <head>
    <!-- localized-seo:start -->placeholder<!-- localized-seo:end -->
    <script>const localeFontStylesheets = /* localized-font-stylesheets */ {};</script>
  </head>
  <body></body>
</html>`;

describe("localized pages", () => {
  it.each([
    ["/", "ko"],
    ["/unknown/", "ko"],
    ["/en", "en"],
    ["/en/", "en"],
    ["/ja/details", "ja"],
  ] as const)("maps %s to the %s locale", (pathname, locale) => {
    expect(siteLocaleFromPathname(pathname)).toBe(locale);
  });

  it.each(SITE_LOCALE_ORDER)(
    "renders the %s page with an independent search contract",
    (locale) => {
      const metadata = SITE_LOCALES[locale];
      const html = renderLocalizedPage(HTML_FIXTURE, locale);

      expect(html).toContain(`<html lang="${metadata.htmlLang}" data-locale="${locale}"`);
      expect(html).toContain(`<title>${metadata.title}</title>`);
      expect(html).toContain(`<link rel="canonical" href="${siteLocaleUrl(locale)}" />`);
      expect(html).toContain(`<meta property="og:locale" content="${metadata.ogLocale}" />`);
      expect(html).toContain(`https://nikkecollection.com${metadata.ogImagePath}`);
      expect(html).toContain(`href="${metadata.fontStylesheet}"`);
      expect(html).toContain('"@type":"SoftwareApplication"');

      for (const alternate of SITE_LOCALE_ORDER) {
        expect(html).toContain(
          `<link rel="alternate" hreflang="${alternate}" href="${siteLocaleUrl(alternate)}" />`,
        );
      }
      expect(html).toContain(
        `<link rel="alternate" hreflang="x-default" href="${siteLocaleUrl("ko")}" />`,
      );
    },
  );

  it("embeds all locale font URLs in the bootstrap map", () => {
    const html = renderLocalizedPage(HTML_FIXTURE, "ko");

    for (const locale of SITE_LOCALE_ORDER) {
      expect(html).toContain(JSON.stringify(SITE_LOCALES[locale].fontStylesheet).slice(1, -1));
    }
    expect(html).not.toContain("localized-font-stylesheets");
  });

  it("fails when a build template loses either localized marker", () => {
    expect(() =>
      renderLocalizedPage(HTML_FIXTURE.replace("data-site-locale-root", ""), "ko"),
    ).toThrowError("Localized HTML marker is missing");
    expect(() =>
      renderLocalizedPage(HTML_FIXTURE.replace("<!-- localized-seo:start -->", ""), "ko"),
    ).toThrowError("Localized SEO block marker is missing");
  });

  it("lists exactly the three canonical locale URLs in the sitemap", () => {
    const sitemap = renderSitemap();
    const locations = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);

    expect(locations).toEqual(SITE_LOCALE_ORDER.map(siteLocaleUrl));
  });

  it.each(SITE_LOCALE_ORDER)("ships a 1200x630 %s Open Graph image", async (locale) => {
    const imagePath = resolve(process.cwd(), "public", SITE_LOCALES[locale].ogImagePath.slice(1));
    const [metadata, file] = await Promise.all([sharp(imagePath).metadata(), stat(imagePath)]);

    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
    expect(metadata.format).toBe("png");
    expect(file.size).toBeGreaterThan(5_000);
  });
});
