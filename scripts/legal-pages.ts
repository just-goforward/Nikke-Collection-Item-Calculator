import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { LEGAL_CHROME } from "../shared/legal/chrome.ts";
import { LICENSES } from "../shared/legal/licenses.ts";
import { PRIVACY_POLICY } from "../shared/legal/privacy.ts";
import { TERMS_OF_SERVICE } from "../shared/legal/terms.ts";
import type { LegalBlock, LegalDocument, LegalSection, LegalText } from "../shared/legal/types.ts";
import {
  SITE_LEGAL_PAGES,
  SITE_LOCALE_ORDER,
  SITE_LOCALES,
  type SiteLegalPage,
  type SiteLocale,
  siteLegalPageUrl,
} from "../shared/siteLocales.ts";
import { type RustShippedCrate, readRustWasmLicenses } from "./rust-wasm-licenses.ts";

export type LegalPageInputs = {
  /** Vite `build.license` output (third-party-licenses.md). */
  npmLicensesMarkdown: string;
  rustCrates: readonly RustShippedCrate[];
};

/** Keyboard-scrollable, labelled wrapper for tables wider than a phone screen. */
function tableRegion(label: string, table: string) {
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(label)}">${table}</div>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderText(text: LegalText, locale: SiteLocale): string {
  if (typeof text === "string") return escapeHtml(text);
  return text
    .map((part) => {
      if (typeof part === "string") return escapeHtml(part);
      if ("href" in part) return `<a href="${escapeHtml(part.href)}">${escapeHtml(part.text)}</a>`;
      return `<mark class="placeholder" title="${LEGAL_CHROME[locale].placeholderLabel}">${escapeHtml(part.placeholder)}</mark>`;
    })
    .join("");
}

function renderBlock(block: LegalBlock, locale: SiteLocale, regionLabel: string): string {
  switch (block.type) {
    case "paragraph":
      return `<p>${renderText(block.text, locale)}</p>`;
    case "placeholder":
      return `<p class="placeholder-block" role="note">${escapeHtml(block.text)}</p>`;
    case "list":
      return `<ul>${block.items.map((item) => `<li>${renderText(item, locale)}</li>`).join("")}</ul>`;
    case "table": {
      const head = block.head.map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`).join("");
      const rows = block.rows
        .map(
          (row) =>
            `<tr>${row.map((cell, index) => (index === 0 ? `<th scope="row">${renderText(cell, locale)}</th>` : `<td>${renderText(cell, locale)}</td>`)).join("")}</tr>`,
        )
        .join("\n");
      return tableRegion(
        regionLabel,
        `<table><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table>`,
      );
    }
  }
}

function renderSection(section: LegalSection, locale: SiteLocale) {
  const blocks = section.blocks
    .map((block) => renderBlock(block, locale, section.heading))
    .join("\n");
  return `<section>\n<h2>${escapeHtml(section.heading)}</h2>\n${blocks}\n</section>`;
}

/** Splits the Vite license report into per-package headings and verbatim license text. */
export function renderNpmLicenses(markdown: string) {
  const packages = markdown.replace(/\r\n?/g, "\n").split(/^## /m).slice(1);
  if (packages.length === 0) throw new Error("third-party-licenses.md lists no packages.");
  return packages
    .map((entry) => {
      const newline = entry.indexOf("\n");
      const heading = (newline < 0 ? entry : entry.slice(0, newline)).trim();
      const body = newline < 0 ? "" : entry.slice(newline + 1).trim();
      return `<h3>${escapeHtml(heading)}</h3>${body ? `\n<pre class="license-text">${escapeHtml(body)}</pre>` : ""}`;
    })
    .join("\n");
}

function renderRustCrates(
  crates: readonly RustShippedCrate[],
  columns: readonly string[],
  heading: string,
) {
  if (crates.length === 0) throw new Error("Rust WASM license manifest lists no crates.");
  const head = columns.map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`).join("");
  const rows = crates
    .map(
      (crate) =>
        `<tr><th scope="row">${escapeHtml(crate.name)}</th><td>${escapeHtml(crate.version)}</td><td>${escapeHtml(crate.license)}</td></tr>`,
    )
    .join("\n");
  const texts = crates
    .map((crate) => {
      if (crate.texts.length === 0) throw new Error(`${crate.name} has no license text.`);
      const files = crate.texts
        .map(
          (entry) =>
            `<h4>${escapeHtml(entry.file)}</h4>\n<pre class="license-text">${escapeHtml(entry.text)}</pre>`,
        )
        .join("\n");
      return `<h3>${escapeHtml(`${crate.name} ${crate.version} (${crate.license})`)}</h3>\n${files}`;
    })
    .join("\n");
  const table = `<table><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table>`;
  return `${tableRegion(heading, table)}\n${texts}`;
}

function legalDocument(page: SiteLegalPage, locale: SiteLocale): LegalDocument {
  if (page === "privacy") return PRIVACY_POLICY[locale];
  if (page === "terms") return TERMS_OF_SERVICE[locale];
  return LICENSES[locale].document;
}

function generatedSections(page: SiteLegalPage, locale: SiteLocale, inputs: LegalPageInputs) {
  if (page !== "licenses") return [];
  const content = LICENSES[locale];
  return [
    `<section>\n<h2>${escapeHtml(content.rustHeading)}</h2>\n<p>${renderText(content.rustIntro, locale)}</p>\n${renderRustCrates(inputs.rustCrates, content.rustColumns, content.rustHeading)}\n</section>`,
    `<section>\n<h2>${escapeHtml(content.npmHeading)}</h2>\n<p>${renderText(content.npmIntro, locale)}</p>\n${renderNpmLicenses(inputs.npmLicensesMarkdown)}\n</section>`,
  ];
}

const THEME_SCRIPT =
  '(()=>{try{const t=localStorage.getItem("collectionThemeMode");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch{document.documentElement.removeAttribute("data-theme")}})();';

// Colors mirror the light/dark tokens in src/styles.css; no app bundle is loaded.
const PAGE_STYLE = `:root{color-scheme:light;--bg:#eef7fb;--surface:#fff;--surface-strong:#f3f8fb;--ink:#172534;--muted:#506475;--strong:#24342e;--line:#d5e6ef;--link:#1d5f8a}
:root[data-theme="dark"]{color-scheme:dark;--bg:#1a1c1f;--surface:#23262a;--surface-strong:#2a2e33;--ink:#e8eaed;--muted:#adb4bd;--strong:#f1f3f5;--line:#393d43;--link:#8cc8ef}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#1a1c1f;--surface:#23262a;--surface-strong:#2a2e33;--ink:#e8eaed;--muted:#adb4bd;--strong:#f1f3f5;--line:#393d43;--link:#8cc8ef}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font),system-ui,sans-serif;font-size:15px;line-height:1.7;overflow-wrap:anywhere}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}
article{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:24px 20px}
a{color:var(--link);text-underline-offset:3px}
a:focus-visible,.table-wrap:focus-visible{outline:2px solid var(--link);outline-offset:2px;border-radius:2px}
.back{margin:0 0 16px;font-weight:600}
h1{margin:0 0 4px;font-size:1.6rem;line-height:1.35;color:var(--strong)}
h2{margin:32px 0 8px;font-size:1.15rem;color:var(--strong)}
h3{margin:20px 0 6px;font-size:1rem;color:var(--strong)}
h4{margin:12px 0 4px;font-size:.9rem;color:var(--muted)}
.effective{margin:0 0 20px;color:var(--muted)}
ul{padding-left:1.25em}
.table-wrap{overflow-x:auto;margin:12px 0}
table{border-collapse:collapse;width:100%;min-width:560px;font-size:14px}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
thead th{background:var(--surface-strong)}
tbody th{font-weight:600}
mark.placeholder{background:#ffe08a;color:#172534;padding:0 3px;border-radius:3px}
.placeholder-block{padding:16px;border:1px dashed var(--muted);border-radius:8px;background:var(--surface-strong);font-weight:600}
.license-text{white-space:pre-wrap;font-size:12px;line-height:1.5;background:var(--surface-strong);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto}
@media (max-width:600px){main{padding:16px 10px 32px}article{padding:18px 14px}h1{font-size:1.35rem}}`;

export function renderLegalPage(page: SiteLegalPage, locale: SiteLocale, inputs: LegalPageInputs) {
  const metadata = SITE_LOCALES[locale];
  const document = legalDocument(page, locale);
  const title = `${document.title} - ${metadata.title}`;
  const alternates = SITE_LOCALE_ORDER.map(
    (alternate) =>
      `<link rel="alternate" hreflang="${alternate}" href="${siteLegalPageUrl(alternate, page)}" />`,
  );
  alternates.push(
    `<link rel="alternate" hreflang="x-default" href="${siteLegalPageUrl("ko", page)}" />`,
  );
  const body = [
    ...document.intro.map((block) => renderBlock(block, locale, document.title)),
    ...document.sections.map((section) => renderSection(section, locale)),
    ...generatedSections(page, locale, inputs),
  ].join("\n");
  return `<!doctype html>
<html lang="${metadata.htmlLang}" data-locale="${locale}" data-legal-page="${page}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(document.description)}" />
<meta name="robots" content="index,follow" />
<link rel="canonical" href="${siteLegalPageUrl(locale, page)}" />
${alternates.join("\n")}
<meta name="color-scheme" content="light dark" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
<link rel="stylesheet" crossorigin href="${metadata.fontStylesheet}" />
<script>${THEME_SCRIPT}</script>
<style>:root{--font:"${metadata.fontFamily}"}
${PAGE_STYLE}</style>
</head>
<body>
<main>
<p class="back"><a href="${metadata.path}">${escapeHtml(LEGAL_CHROME[locale].back)}</a></p>
<article>
<h1>${escapeHtml(document.title)}</h1>
${document.effective ? `<p class="effective">${renderText(document.effective, locale)}</p>` : ""}
${body}
</article>
</main>
</body>
</html>
`;
}

/** Output file for an extensionless route; Workers assets serve `/en/privacy` from `en/privacy.html`. */
export function legalPageFile(page: SiteLegalPage, locale: SiteLocale) {
  return `${SITE_LOCALES[locale].path.slice(1)}${page}.html`;
}

export async function writeLegalBuildPages(distDir: string) {
  const inputs: LegalPageInputs = {
    npmLicensesMarkdown: await readFile(resolve(distDir, "third-party-licenses.md"), "utf8"),
    rustCrates: (await readRustWasmLicenses()).crates,
  };
  for (const locale of SITE_LOCALE_ORDER) {
    for (const page of SITE_LEGAL_PAGES) {
      const output = resolve(distDir, legalPageFile(page, locale));
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, renderLegalPage(page, locale, inputs), "utf8");
    }
  }
}
