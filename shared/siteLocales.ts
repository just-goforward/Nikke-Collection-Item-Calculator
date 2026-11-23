import type { StatsLocale } from "./statsContract.ts";

declare const __ISOLATED_ROOT_CANDIDATE__: boolean;
declare const __PRODUCTION_ROOT_SITE__: boolean;
const siteBase = (typeof __ISOLATED_ROOT_CANDIDATE__ !== 'undefined' && __ISOLATED_ROOT_CANDIDATE__) ||
  (typeof __PRODUCTION_ROOT_SITE__ !== 'undefined' && __PRODUCTION_ROOT_SITE__) ? '/' : '/preview/';

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
  path: `${typeof siteBase}${"" | "en/" | "ja/"}`;
  title: string;
};

export const SITE_LOCALES = {
  ko: {
    description: "니케 소장품 레벨업에 필요한 키트 사용 순서와 SR 15 도달 확률을 계산합니다.",
    fontFamily: "Pretendard Variable",
    fontStylesheet: `${siteBase}fonts/pretendard-1.3.9/ko/pretendardvariable-dynamic-subset.css`,
    htmlLang: "ko",
    ogImagePath: `${siteBase}og/collection-calculator-ko.png`,
    ogLocale: "ko_KR",
    path: `${siteBase}`,
    title: "NIKKE 소장품 레벨업 계산기",
  },
  en: {
    description:
      "Calculate the best Maintenance Kit order and your chance of reaching SR Phase 15 in NIKKE.",
    fontFamily: "Pretendard Std Variable",
    fontStylesheet: `${siteBase}fonts/pretendard-1.3.9/en/pretendardvariable-std-dynamic-subset.css`,
    htmlLang: "en",
    ogImagePath: `${siteBase}og/collection-calculator-en.png`,
    ogLocale: "en_US",
    path: `${siteBase}en/`,
    title: "NIKKE Collection Item Upgrade Calculator",
  },
  ja: {
    description:
      "NIKKEのコレクション強化に使うお手入れキットの順番と、SR15段階到達率を計算します。",
    fontFamily: "Pretendard JP Variable",
    fontStylesheet: `${siteBase}fonts/pretendard-1.3.9/ja/pretendardvariable-jp-dynamic-subset.css`,
    htmlLang: "ja",
    ogImagePath: `${siteBase}og/collection-calculator-ja.png`,
    ogLocale: "ja_JP",
    path: `${siteBase}ja/`,
    title: "NIKKE コレクション強化計算機",
  },
} as const satisfies Record<SiteLocale, SiteLocaleMetadata>;

export function siteLocaleFromPathname(pathname: string): SiteLocale {
  const firstSegment = pathname.slice(siteBase.length).split("/")[0]?.toLowerCase();
  if (firstSegment === "en" || firstSegment === "ja") return firstSegment;
  return "ko";
}

export function siteLocaleUrl(locale: SiteLocale) {
  return `${SITE_ORIGIN}${SITE_LOCALES[locale].path}`;
}

export const SITE_CONTACT_EMAIL = "contact@nikkecollection.com";
export const SITE_SOURCE_REPOSITORY =
  "https://github.com/just-goforward/Nikke-Collection-Item-Calculator";
export const SITE_LICENSE_URL = `${SITE_SOURCE_REPOSITORY}/blob/main/LICENSE`;

export const SITE_LEGAL_PAGES = ["privacy", "terms", "licenses"] as const;
export type SiteLegalPage = (typeof SITE_LEGAL_PAGES)[number];

/** Extensionless path served from the build's `<page>.html` asset. */
export function siteLegalPagePath(locale: SiteLocale, page: SiteLegalPage) {
  return `${SITE_LOCALES[locale].path}${page}`;
}

export function siteLegalPageUrl(locale: SiteLocale, page: SiteLegalPage) {
  return `${SITE_ORIGIN}${siteLegalPagePath(locale, page)}`;
}

/** Every indexable URL: the locale homes first, then each locale's legal pages. */
export function siteSitemapUrls() {
  return [
    ...SITE_LOCALE_ORDER.map(siteLocaleUrl),
    ...SITE_LOCALE_ORDER.flatMap((locale) =>
      SITE_LEGAL_PAGES.map((page) => siteLegalPageUrl(locale, page)),
    ),
  ];
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
