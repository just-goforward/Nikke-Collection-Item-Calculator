import type { StatsLocale } from "./statsContract.ts";

export const SITE_ORIGIN = "https://nikkecollection.com";

export const SITE_LOCALE_ORDER = ["ko", "en", "ja"] as const satisfies readonly StatsLocale[];

export type SiteLocale = StatsLocale;

export type SiteLocaleMetadata = {
  description: string;
  fontFamily: string;
  fontStylesheet: string;
  htmlLang: SiteLocale;
  ogImagePath: string;
  ogLocale: string;
  path: "/" | "/en/" | "/ja/";
  title: string;
};

export const SITE_LOCALES = {
  ko: {
    description: "니케 소장품 레벨업에 필요한 키트 사용 순서와 SR 15 도달 확률을 계산합니다.",
    fontFamily: "Pretendard Variable",
    fontStylesheet:
      "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css",
    htmlLang: "ko",
    ogImagePath: "/og/collection-calculator-ko.png",
    ogLocale: "ko_KR",
    path: "/",
    title: "NIKKE 소장품 레벨업 계산기",
  },
  en: {
    description:
      "Calculate the best Maintenance Kit order and your chance of reaching SR Phase 15 in NIKKE.",
    fontFamily: "Pretendard Std Variable",
    fontStylesheet:
      "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-std-dynamic-subset.min.css",
    htmlLang: "en",
    ogImagePath: "/og/collection-calculator-en.png",
    ogLocale: "en_US",
    path: "/en/",
    title: "NIKKE Collection Item Upgrade Calculator",
  },
  ja: {
    description:
      "NIKKEのコレクション強化に使うお手入れキットの順番と、SR15段階到達率を計算します。",
    fontFamily: "Pretendard JP Variable",
    fontStylesheet:
      "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-jp-dynamic-subset.min.css",
    htmlLang: "ja",
    ogImagePath: "/og/collection-calculator-ja.png",
    ogLocale: "ja_JP",
    path: "/ja/",
    title: "NIKKE コレクション強化計算機",
  },
} as const satisfies Record<SiteLocale, SiteLocaleMetadata>;

export function siteLocaleFromPathname(pathname: string): SiteLocale {
  const firstSegment = pathname.split("/").find(Boolean)?.toLowerCase();
  if (firstSegment === "en" || firstSegment === "ja") return firstSegment;
  return "ko";
}

export function siteLocaleUrl(locale: SiteLocale) {
  return `${SITE_ORIGIN}${SITE_LOCALES[locale].path}`;
}

export function siteLocaleJsonLd(locale: SiteLocale) {
  const metadata = SITE_LOCALES[locale];
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    applicationCategory: "UtilitiesApplication",
    description: metadata.description,
    image: `${SITE_ORIGIN}${metadata.ogImagePath}`,
    inLanguage: metadata.htmlLang,
    isAccessibleForFree: true,
    name: metadata.title,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    operatingSystem: "Any",
    url: siteLocaleUrl(locale),
  };
}
