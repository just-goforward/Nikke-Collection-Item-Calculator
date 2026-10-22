import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PRIVACY_POLICY } from "../shared/legal/privacy";
import { TERMS_OF_SERVICE } from "../shared/legal/terms";
import {
  SITE_LEGAL_PAGES,
  SITE_LOCALE_ORDER,
  SITE_LOCALES,
  siteLegalPagePath,
  siteLegalPageUrl,
} from "../shared/siteLocales";
import { STATS_OUTBOX_TTL_MS } from "../src/lib/statsSubmissionOutbox";
import { assertProductionHtml } from "./build-site-production";
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
      expect(html.match(/<mark class="placeholder"/g) ?? []).toHaveLength(0);
      if (page !== "licenses") {
        const effectiveDates = {
          ko: "시행일: 2026년 10월 21일",
          en: "Effective date: October 21, 2026",
          ja: "施行日: 2026年10月21日",
        };
        expect(html).toContain(effectiveDates[locale]);
      }
    });
  }

  it("renders the Korean privacy policy with its effective date, tables and contact email", () => {
    const html = renderLegalPage("privacy", "ko", inputs);
    expect(html).toContain("<title>개인정보 처리방침 - NIKKE 소장품 레벨업 계산기</title>");
    expect(html).toContain("시행일: 2026년 10월 21일");
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

  it.each(SITE_LOCALE_ORDER)(
    "renders the %s terms with local legal links and contact",
    (locale) => {
      const html = renderLegalPage("terms", locale, inputs);
      expect(html).not.toContain('<p class="placeholder-block"');
      expect(html.match(/<mark class="placeholder"/g) ?? []).toHaveLength(0);
      expect(html).toContain(`href="${siteLegalPagePath(locale, "privacy")}"`);
      expect(html).toContain(`href="${siteLegalPagePath(locale, "licenses")}"`);
      expect(html).toContain(
        '<a href="mailto:contact@nikkecollection.com">contact@nikkecollection.com</a>',
      );
      expect(html.match(/<h2/g)).toHaveLength(11);
    },
  );

  it("keeps every terms translation structurally aligned with the Korean source", () => {
    const shape = (locale: (typeof SITE_LOCALE_ORDER)[number]) =>
      TERMS_OF_SERVICE[locale].sections.map((section) =>
        section.blocks.map((block) =>
          block.type === "list" ? [block.type, block.items.length] : [block.type],
        ),
      );
    expect(shape("en")).toEqual(shape("ko"));
    expect(shape("ja")).toEqual(shape("ko"));
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
});

const sourceNumber = (path: string, pattern: RegExp) => {
  const match = readFileSync(path, "utf8").match(pattern);
  if (!match?.[1]) throw new Error(`${pattern} not found in ${path}`);
  return Number(match[1].replaceAll("_", ""));
};
const outboxMinutes = STATS_OUTBOX_TTL_MS / 60_000;
const recoveryMinutes = sourceNumber(
  "src/lib/legacyInputRecovery.ts",
  /const TTL_MS = ([\d_]+) \* 60_000;/,
);
const cleanupDays = sourceNumber("cloudflare/src/rate-limit.ts", /now - 86400 \* (\d+);/);
const productionSampling = sourceNumber(
  "cloudflare/wrangler.toml",
  /^\[observability\.logs\][^[]*?^head_sampling_rate = ([\d.]+)$/m,
);
const privacyFacts = {
  ko: [
    `전송하지 못한 결과·진단 정보: ${outboxMinutes}분간 재전송용으로 보관`,
    `약 ${recoveryMinutes}분 안에 다시 불러올 때만 복구에 쓰고`,
    `${cleanupDays}일이 지나면 매일 정리 작업에서 삭제`,
    "통상 요청의 약 10%를 무작위로 기록",
    "일시적으로 모든 요청을 기록합니다",
    "문의 메일 전달(Email Routing)",
    "문의 메일 전달 기록(발신자·수신자 주소, 제목 등)은 31일",
    "문의 메일 수신 시 Cloudflare Email Routing을 거쳐 네트워크로 전송",
    "계산 진단 정보는 계산이 완료되면 자동으로 전송되므로(시험용 certified 모드 제외)",
    "문의 메일(Gmail)은 보내지 않으면 되지만, 다른 문의 창구가 없어 문의를 받거나 답변할 수 없습니다.",
    "글꼴(jsDelivr)은 브라우저에서 cdn.jsdelivr.net을 차단하면 되며",
    "보안, 서비스 개선, 법적 의무를 위해 더 오래 보관할 수 있음",
  ],
  en: [
    `Results and diagnostics not yet submitted: kept for resubmission for ${outboxMinutes} minutes`,
    `within about ${recoveryMinutes} minutes`,
    `once ${cleanupDays} days have passed`,
    "a random sample of about 10% of requests",
    "all requests are temporarily recorded",
    "forwarding inquiry emails (Email Routing)",
    "Inquiry email forwarding records (sender and recipient addresses, subject, etc.): 31 days",
    "Network transmission via Cloudflare Email Routing when an inquiry email is received",
    "calculation diagnostics are sent automatically when a calculation completes (except in the trial certified mode)",
    "You can simply not send inquiry emails (Gmail), but as there is no other inquiry channel",
    "Fonts (jsDelivr) can be avoided by blocking cdn.jsdelivr.net in your browser",
    "jsDelivr may keep data longer for security, service improvement or legal obligations",
  ],
  ja: [
    `未送信の結果・診断情報: 再送信用に${outboxMinutes}分間保持`,
    `約${recoveryMinutes}分以内に再読み込みした場合のみ`,
    `${cleanupDays}日が経過すると毎日の整理処理で削除`,
    "リクエストの約10%を無作為に記録",
    "一時的にすべてのリクエストを記録します",
    "お問い合わせメールの転送(Email Routing)",
    "お問い合わせメールの転送記録(送信者・受信者のアドレス、件名など)は31日",
    "お問い合わせメール受信時にCloudflare Email Routingを経由してネットワークで送信",
    "計算の診断情報は計算が完了すると自動で送信されるため(試験用certifiedモードを除く)",
    "お問い合わせメール(Gmail)は送信しないことができますが、ほかにお問い合わせ窓口がないため",
    "フォント(jsDelivr)はブラウザでcdn.jsdelivr.netをブロックでき",
    "セキュリティ、サービス改善、法的義務のためにより長く保管する場合あり",
  ],
} as const;
const termsFacts = {
  ko: [
    "서비스 운영자에게 고의나 중대한 과실이 없는 한",
    "다만 관련 법령이 달리 정하는 경우에는 그 법령을 따릅니다.",
    "약관을 바꾸면 시행 7일 전부터 이 페이지에 알립니다.",
    "AGPL-3.0-or-later 라이선스로 공개되어 있습니다.",
  ],
  en: [
    "Unless the damage results from the service operator’s intentional misconduct or gross negligence",
    "However, where applicable laws provide otherwise, those laws apply.",
    "notice will be posted on this page from 7 days before the changes take effect",
    "published under the AGPL-3.0-or-later license",
  ],
  ja: [
    "サービス運営者に故意または重大な過失がない限り",
    "ただし、関連法令に別段の定めがある場合は、その法令に従います。",
    "施行の7日前からこのページでお知らせします。",
    "AGPL-3.0-or-laterライセンスで公開されています。",
  ],
} as const;
const documentText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map(documentText).join("\n")
      : value && typeof value === "object"
        ? Object.values(value).map(documentText).join("\n")
        : "";

describe("legal page content and publish gate", () => {
  it("reads the disclosed production log sampling rate from wrangler.toml", () => {
    // Full sampling is the disclosed temporary migration setting; 0.1 is the disclosed normal rate.
    expect([1, 0.1]).toContain(productionSampling);
  });

  it.each(SITE_LOCALE_ORDER)("states the reviewed privacy and terms facts in %s", (locale) => {
    const privacy = documentText(PRIVACY_POLICY[locale]);
    for (const fact of privacyFacts[locale]) expect(privacy).toContain(fact);
    const terms = documentText(TERMS_OF_SERVICE[locale]);
    for (const fact of termsFacts[locale]) expect(terms).toContain(fact);
  });

  it("fails the production build on any unfilled legal placeholder", () => {
    const html = renderLegalPage("terms", "ko", inputs);
    expect(() => assertProductionHtml(html, "terms.html", "")).not.toThrow();
    for (const marker of [
      '<mark class="placeholder" title="입력 예정">2026년 ○월 ○일</mark>',
      '<p class="placeholder-block" role="note">준비 중</p>',
    ]) {
      expect(() =>
        assertProductionHtml(html.replace("</article>", `${marker}</article>`), "terms.html", ""),
      ).toThrowError("Unfilled legal placeholder in terms.html");
    }
  });

  it("passes the staging transform without a stats configuration script", () => {
    const html = renderLegalPage("privacy", "ja", inputs);
    expect(stagingHtml(html)).toContain('<meta name="robots" content="noindex,nofollow" />');
  });
});
