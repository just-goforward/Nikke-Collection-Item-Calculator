import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

import {
  SITE_LOCALE_ORDER,
  SITE_LOCALES,
  SITE_ORIGIN,
  type SiteLocale,
  siteLocaleFromPathname,
  siteLocaleJsonLd,
  siteLocaleUrl,
} from "../shared/siteLocales.ts";

const SEO_BLOCK_PATTERN = /<!-- localized-seo:start -->[\s\S]*?<!-- localized-seo:end -->/;
const HTML_LOCALE_PATTERN = /<html lang="[^"]+" data-locale="[^"]+" data-site-locale-root>/;
const FONT_MAP_MARKER = "/* localized-font-stylesheets */ {}";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function serializeJsonLd(locale: SiteLocale) {
  return JSON.stringify(siteLocaleJsonLd(locale)).replaceAll("<", "\\u003c");
}

export function localizedSeoBlock(locale: SiteLocale) {
  const metadata = SITE_LOCALES[locale];
  const canonical = siteLocaleUrl(locale);
  const alternateLinks = SITE_LOCALE_ORDER.map(
    (alternate) =>
      `    <link rel="alternate" hreflang="${alternate}" href="${siteLocaleUrl(alternate)}" />`,
  );
  alternateLinks.push(
    `    <link rel="alternate" hreflang="x-default" href="${siteLocaleUrl("ko")}" />`,
  );
  const alternateOgLocales = SITE_LOCALE_ORDER.filter((alternate) => alternate !== locale).map(
    (alternate) =>
      `    <meta property="og:locale:alternate" content="${SITE_LOCALES[alternate].ogLocale}" />`,
  );
  const title = escapeHtml(metadata.title);
  const description = escapeHtml(metadata.description);
  const imageUrl = `${SITE_ORIGIN}${metadata.ogImagePath}`;

  return [
    "<!-- localized-seo:start -->",
    `    <title>${title}</title>`,
    `    <meta name="description" content="${description}" />`,
    '    <meta name="robots" content="index,follow,max-image-preview:large" />',
    `    <link rel="canonical" href="${canonical}" />`,
    ...alternateLinks,
    '    <meta property="og:type" content="website" />',
    '    <meta property="og:site_name" content="NIKKE Collection Item Calculator" />',
    `    <meta property="og:title" content="${title}" />`,
    `    <meta property="og:description" content="${description}" />`,
    `    <meta property="og:url" content="${canonical}" />`,
    `    <meta property="og:locale" content="${metadata.ogLocale}" />`,
    ...alternateOgLocales,
    `    <meta property="og:image" content="${imageUrl}" />`,
    `    <meta property="og:image:alt" content="${title}" />`,
    '    <meta property="og:image:width" content="1200" />',
    '    <meta property="og:image:height" content="630" />',
    '    <meta name="twitter:card" content="summary_large_image" />',
    `    <meta name="twitter:title" content="${title}" />`,
    `    <meta name="twitter:description" content="${description}" />`,
    `    <meta name="twitter:image" content="${imageUrl}" />`,
    `    <script id="site-structured-data" type="application/ld+json">${serializeJsonLd(locale)}</script>`,
    "    <noscript>",
    "      <link",
    '        rel="stylesheet"',
    "        crossorigin",
    `        href="${metadata.fontStylesheet}"`,
    "      />",
    "    </noscript>",
    "<!-- localized-seo:end -->",
  ].join("\n");
}

function fontStylesheetMap() {
  return Object.fromEntries(
    SITE_LOCALE_ORDER.map((locale) => [locale, SITE_LOCALES[locale].fontStylesheet]),
  );
}

export function renderLocalizedPage(html: string, locale: SiteLocale) {
  if (!HTML_LOCALE_PATTERN.test(html)) {
    throw new Error("Localized HTML marker is missing from the document element.");
  }
  if (!SEO_BLOCK_PATTERN.test(html)) {
    throw new Error("Localized SEO block marker is missing from the document head.");
  }
  const metadata = SITE_LOCALES[locale];
  let rendered = html
    .replace(
      HTML_LOCALE_PATTERN,
      `<html lang="${metadata.htmlLang}" data-locale="${locale}" data-site-locale-root>`,
    )
    .replace(SEO_BLOCK_PATTERN, localizedSeoBlock(locale));
  if (rendered.includes(FONT_MAP_MARKER)) {
    rendered = rendered.replace(FONT_MAP_MARKER, JSON.stringify(fontStylesheetMap()));
  }
  return rendered;
}

export function renderSitemap() {
  const urls = SITE_LOCALE_ORDER.map(
    (locale) => `  <url>\n    <loc>${siteLocaleUrl(locale)}</loc>\n  </url>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

async function writeLocalizedBuildPages(distDir: string) {
  const rootIndex = resolve(distDir, "index.html");
  const rootHtml = await readFile(rootIndex, "utf8");
  for (const locale of ["en", "ja"] as const) {
    const output = resolve(distDir, SITE_LOCALES[locale].path.slice(1), "index.html");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, renderLocalizedPage(rootHtml, locale), "utf8");
  }
  await writeFile(resolve(distDir, "sitemap.xml"), renderSitemap(), "utf8");
}

export function localizedPagesPlugin(): Plugin {
  let resolvedConfig: ResolvedConfig | null = null;
  return {
    name: "localized-pages",
    enforce: "post",
    configResolved(config) {
      resolvedConfig = config;
    },
    transformIndexHtml(html, context) {
      const locale = siteLocaleFromPathname(context.path);
      return renderLocalizedPage(html, locale);
    },
    async closeBundle() {
      if (resolvedConfig?.command !== "build") return;
      await writeLocalizedBuildPages(resolve(resolvedConfig.root, resolvedConfig.build.outDir));
    },
  };
}
