import { describe, expect, it } from "vitest";

import { PRIVACY_POLICY } from "../shared/legal/privacy";
import {
  SITE_LEGAL_PAGES,
  SITE_LOCALE_ORDER,
  SITE_LOCALES,
  siteLegalPagePath,
  siteLegalPageUrl,
} from "../shared/siteLocales";
import { stagingHtml } from "./build-site-staging";
import { legalPageFile, renderLegalPage, renderNpmLicenses } from "./legal-pages";

const inputs = {
  npmLicensesMarkdown:
    "# Licenses\n\nThe app bundles dependencies:\n\n## react - 19.3.1 (MIT)\n\nMIT License <x>\n",
  rustCrates: [
    {
      name: "itoa",
      version: "1.0.18",
      license: "MIT OR Apache-2.0",
      texts: [
        { file: "LICENSE-APACHE", text: "Apache License <2.0>" },
        { file: "LICENSE-MIT", text: "Permission is hereby granted" },
      ],
    },
  ],
};

describe("legal pages", () => {
  it.each(SITE_LOCALE_ORDER)("maps %s legal routes to extensionless html assets", (locale) => {
    const prefix = SITE_LOCALES[locale].path;
    expect(SITE_LEGAL_PAGES.map((page) => siteLegalPagePath(locale, page))).toEqual(
      SITE_LEGAL_PAGES.map((page) => `${prefix}${page}`),
    );
    expect(SITE_LEGAL_PAGES.map((page) => legalPageFile(page, locale))).toEqual(
      SITE_LEGAL_PAGES.map((page) => `${prefix.slice(1)}${page}.html`),
    );
  });

  for (const page of SITE_LEGAL_PAGES) {
    it.each(SITE_LOCALE_ORDER)(`renders ${page} for %s with its search contract`, (locale) => {
      const html = renderLegalPage(page, locale, inputs);
      expect(html).toContain(`<html lang="${SITE_LOCALES[locale].htmlLang}"`);
      expect(html).toContain(`<link rel="canonical" href="${siteLegalPageUrl(locale, page)}" />`);
      for (const alternate of SITE_LOCALE_ORDER) {
        expect(html).toContain(
          `<link rel="alternate" hreflang="${alternate}" href="${siteLegalPageUrl(alternate, page)}" />`,
        );
      }
      expect(html).toContain(`<p class="back"><a href="${SITE_LOCALES[locale].path}">`);
      expect(html).not.toMatch(/<script\b[^>]*\bsrc=/);
    });
  }

  it("renders the Korean privacy draft with placeholders, tables and the contact email", () => {
    const html = renderLegalPage("privacy", "ko", inputs);
    expect(html).toContain("<title>개인정보 처리방침 - NIKKE 소장품 레벨업 계산기</title>");
    expect(html).toContain('<mark class="placeholder" title="입력 예정">2026년 ○월 ○일</mark>');
    expect(html).toContain("개인정보 보호책임자: 서비스 운영자");
    expect(html).toContain(
      "도메인 이전 점검 기간(2026년 10월 28일 무렵 종료 예정)에는 일시적으로 모든 요청을 기록합니다",
    );
    expect(html).toContain("Cloudflare, Inc. (dpo@cloudflare.com)");
    expect(html).toContain("Google LLC (Gmail) (googlekrsupport@google.com)");
    expect(html).toContain("처리 완료 후 1년 보관 후 삭제");
    expect(html).toContain('href="https://www.cloudflare.com/turnstile-privacy-policy/"');
    expect(html).toContain(
      '<a href="mailto:contact@nikkecollection.com">contact@nikkecollection.com</a>',
    );
    expect(html.match(/<table>/g)).toHaveLength(2);
    expect(html).toContain(
      '<div class="table-wrap" tabindex="0" role="region" aria-label="1. 처리하는 정보와 목적">',
    );
    expect(html).toContain(
      '<div class="table-wrap" tabindex="0" role="region" aria-label="3. 처리 위탁 및 국외 이전">',
    );
    expect(html).toContain("계산 엔진 진단 정보");
    expect(html).toContain("Volentio JSD Limited (jsDelivr) (legal@jsdelivr.com)");
    expect(html).toContain('href="https://www.jsdelivr.com/terms/privacy-policy"');
  });

  it("keeps every privacy translation structurally aligned with the Korean source", () => {
    const shape = (locale: (typeof SITE_LOCALE_ORDER)[number]) =>
      PRIVACY_POLICY[locale].sections.map((section) =>
        section.blocks.map((block) =>
          block.type === "table"
            ? [block.type, block.head.length, block.rows.length]
            : block.type === "list"
              ? [block.type, block.items.length]
              : [block.type],
        ),
      );
    expect(shape("en")).toEqual(shape("ko"));
    expect(shape("ja")).toEqual(shape("ko"));
  });

  it("marks the terms body as a placeholder in every locale", () => {
    expect(renderLegalPage("terms", "ko", inputs)).toContain(
      '<p class="placeholder-block" role="note">이용약관 준비 중입니다.</p>',
    );
  });

  it("includes the project license, Rust crates and escaped npm notices", () => {
    const html = renderLegalPage("licenses", "en", inputs);
    expect(html).toContain("AGPL-3.0-or-later, without any warranty");
    expect(html).toContain(
      'href="https://github.com/just-goforward/Nikke-Collection-Item-Calculator/blob/main/LICENSE"',
    );
    expect(html).toContain(
      '<tr><th scope="row">itoa</th><td>1.0.18</td><td>MIT OR Apache-2.0</td></tr>',
    );
    expect(html).toContain("<h3>itoa 1.0.18 (MIT OR Apache-2.0)</h3>");
    expect(html).toContain(
      '<h4>LICENSE-APACHE</h4>\n<pre class="license-text">Apache License &lt;2.0&gt;</pre>',
    );
    expect(html).toContain('<pre class="license-text">Permission is hereby granted</pre>');
    expect(html).toContain(
      '<div class="table-wrap" tabindex="0" role="region" aria-label="Rust crates compiled into WASM">',
    );
    expect(() =>
      renderLegalPage("licenses", "en", {
        ...inputs,
        rustCrates: [{ name: "itoa", version: "1.0.18", license: "MIT", texts: [] }],
      }),
    ).toThrowError("has no license text");
    expect(html).toContain("<h3>react - 19.3.1 (MIT)</h3>");
    expect(html).toContain("MIT License &lt;x&gt;");
    expect(() => renderNpmLicenses("# Licenses\n")).toThrowError("lists no packages");
  });

  it("passes the staging transform without a stats configuration script", () => {
    const html = renderLegalPage("privacy", "ja", inputs);
    expect(stagingHtml(html)).toContain('<meta name="robots" content="noindex,nofollow" />');
  });
});
