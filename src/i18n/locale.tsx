import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import {
  SITE_LOCALE_ORDER,
  SITE_LOCALES,
  type SiteLocale,
  siteLocaleFromPathname,
  siteLocaleJsonLd,
  siteLocaleUrl,
} from "../../shared/siteLocales";
import { ignoreExpectedError } from "../lib/errorHandling";
import { enMessages } from "./messages.en";
import { jaMessages } from "./messages.ja";
import {
  koMessages,
  type LocalizedMessage,
  type MessageKey,
  type MessageParams,
} from "./messages.ko";

export type AppLocale = SiteLocale;
type CountUnit = "attempt" | "input" | "person" | "piece" | "state" | "use";

const LOCALE_FONT_LINK_ID = "locale-font-stylesheet";
const LOCALE_FONT_LOAD_TIMEOUT_MS = 5_000;
const LOCALE_CODES: Record<AppLocale, string> = {
  ko: "ko-KR",
  en: "en-US",
  ja: "ja-JP",
};
const FONT_STYLESHEETS: Record<AppLocale, string> = {
  ko: SITE_LOCALES.ko.fontStylesheet,
  en: SITE_LOCALES.en.fontStylesheet,
  ja: SITE_LOCALES.ja.fontStylesheet,
};
const FONT_FAMILY_NAMES: Record<AppLocale, string> = {
  ko: SITE_LOCALES.ko.fontFamily,
  en: SITE_LOCALES.en.fontFamily,
  ja: SITE_LOCALES.ja.fontFamily,
};
const MESSAGE_CATALOGS = {
  ko: koMessages,
  en: enMessages,
  ja: jaMessages,
} satisfies Record<AppLocale, Record<MessageKey, string>>;
const interpolationFormatters = new Map<AppLocale, Intl.NumberFormat>();
const decimalFormatters = new Map<string, Intl.NumberFormat>();
const integerFormatters = new Map<AppLocale, Intl.NumberFormat>();
const UNIT_LABELS: Record<AppLocale, Record<CountUnit, readonly [string, string]>> = {
  ko: {
    attempt: ["회", "회"],
    input: ["입력", "입력"],
    person: ["명", "명"],
    piece: ["개", "개"],
    state: ["개 상태", "개 상태"],
    use: ["회", "회"],
  },
  en: {
    attempt: ["attempt", "attempts"],
    input: ["input", "inputs"],
    person: ["Commander", "Commanders"],
    piece: ["piece", "pieces"],
    state: ["state", "states"],
    use: ["use", "uses"],
  },
  ja: {
    attempt: ["回", "回"],
    input: ["入力", "入力"],
    person: ["人", "人"],
    piece: ["個", "個"],
    state: ["個の状態", "個の状態"],
    use: ["回", "回"],
  },
};

type LocaleContextValue = {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => Promise<void>;
  t: (key: MessageKey, params?: MessageParams) => string;
  text: (message: LocalizedMessage) => string;
  formatCount: (value: number, unit: CountUnit) => string;
  formatInteger: (value: number) => string;
  formatNumber: (value: number, digits?: number) => string;
  formatPercent: (value: number, digits?: number) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);
const localeFontStylesheetPromises = new Map<AppLocale, Promise<boolean>>();

export function localeFromLanguageTag(language: string | null | undefined): AppLocale | null {
  if (!language) return null;
  const normalized = language.trim().toLowerCase();
  if (normalized === "ko" || normalized.startsWith("ko-")) return "ko";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return null;
}

export function detectInitialLocale(): AppLocale {
  if (typeof window !== "undefined") {
    return siteLocaleFromPathname(window.location.pathname);
  }
  if (typeof document !== "undefined") {
    const documentLocale = localeFromLanguageTag(
      document.documentElement.getAttribute("data-locale"),
    );
    if (documentLocale) return documentLocale;
  }
  return "ko";
}

function interpolate(locale: AppLocale, template: string, params?: MessageParams) {
  if (!params) return template;
  let formatter = interpolationFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(LOCALE_CODES[locale], { maximumFractionDigits: 20 });
    interpolationFormatters.set(locale, formatter);
  }
  let result = template;
  for (const [key, value] of Object.entries(params)) {
    const formatted = typeof value === "number" ? formatter.format(value) : value;
    result = result.split(`{${key}}`).join(String(formatted));
  }
  return result;
}

export function translate(locale: AppLocale, key: MessageKey, params?: MessageParams) {
  return interpolate(locale, MESSAGE_CATALOGS[locale][key], params);
}

export function message(key: MessageKey, params?: MessageParams): LocalizedMessage {
  return params ? { key, params } : { key };
}

export function translateMessage(locale: AppLocale, value: LocalizedMessage) {
  return translate(locale, value.key, value.params);
}

function formatNumberForLocale(locale: AppLocale, value: number, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  const key = `${locale}:${digits}`;
  let formatter = decimalFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(LOCALE_CODES[locale], {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    });
    decimalFormatters.set(key, formatter);
  }
  return formatter.format(value);
}

export function formatIntegerForLocale(locale: AppLocale, value: number) {
  let formatter = integerFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(LOCALE_CODES[locale], { maximumFractionDigits: 0 });
    integerFormatters.set(locale, formatter);
  }
  return formatter.format(value);
}

function renderedLocaleFontSample() {
  const renderedText = document.getElementById("app")?.innerText ?? "";
  return [...new Set(`${renderedText} 0123456789 × % R SR EXP`)].join("");
}

function createLocaleFontLink(locale: AppLocale) {
  const link = document.createElement("link");
  link.id = `${LOCALE_FONT_LINK_ID}-${locale}`;
  link.setAttribute("data-locale-font", locale);
  link.setAttribute("data-load-state", "loading");
  link.rel = "stylesheet";
  link.media = "print";
  link.crossOrigin = "anonymous";
  link.href = FONT_STYLESHEETS[locale];
  link.addEventListener("load", () => {
    link.media = "all";
    link.setAttribute("data-load-state", "loaded");
  });
  link.addEventListener("error", () => {
    link.setAttribute("data-load-state", "error");
  });
  document.head.append(link);
  return link;
}

function localeFontLink(locale: AppLocale) {
  const selector = `link[data-locale-font="${locale}"]`;
  const current = document.querySelector<HTMLLinkElement>(selector);
  if (current?.getAttribute("data-load-state") !== "error") {
    return current ?? createLocaleFontLink(locale);
  }
  current.remove();
  return createLocaleFontLink(locale);
}

function remainingFontLoadTime(deadline: number) {
  return Math.max(0, deadline - performance.now());
}

function waitForStylesheet(link: HTMLLinkElement, deadline: number) {
  if (link.getAttribute("data-load-state") === "loaded") return Promise.resolve(true);
  if (link.getAttribute("data-load-state") === "error") return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      link.removeEventListener("load", handleLoad);
      link.removeEventListener("error", handleError);
      resolve(loaded);
    };
    const handleLoad = () => finish(true);
    const handleError = () => finish(false);
    const timeoutId = window.setTimeout(() => finish(false), remainingFontLoadTime(deadline));
    link.addEventListener("load", handleLoad, { once: true });
    link.addEventListener("error", handleError, { once: true });
  });
}

function waitForFontFace(locale: AppLocale, sample: string, deadline: number) {
  if (!document.fonts) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      resolve(loaded);
    };
    const timeoutId = window.setTimeout(() => finish(false), remainingFontLoadTime(deadline));
    document.fonts
      .load(`600 1rem "${FONT_FAMILY_NAMES[locale]}"`, sample)
      .then(() => finish(true))
      .catch((error: unknown) => {
        ignoreExpectedError("locale font loading can fail and use the system fallback", error);
        finish(false);
      });
  });
}

function ensureLocaleFontStylesheet(locale: AppLocale, deadline: number) {
  const cached = localeFontStylesheetPromises.get(locale);
  if (cached) return cached;
  const pending = waitForStylesheet(localeFontLink(locale), deadline);
  localeFontStylesheetPromises.set(locale, pending);
  void pending.then((loaded) => {
    if (!loaded && localeFontStylesheetPromises.get(locale) === pending) {
      localeFontStylesheetPromises.delete(locale);
    }
  });
  return pending;
}

async function loadRenderedLocaleFont(locale: AppLocale) {
  const deadline = performance.now() + LOCALE_FONT_LOAD_TIMEOUT_MS;
  const sample = renderedLocaleFontSample();
  const stylesheetLoaded = await ensureLocaleFontStylesheet(locale, deadline);
  if (!stylesheetLoaded) return false;
  return waitForFontFace(locale, sample, deadline);
}

function setMetaContent(selector: string, content: string) {
  const meta = document.querySelector<HTMLMetaElement>(selector);
  if (meta) meta.content = content;
}

function applySeoMetadata(locale: AppLocale) {
  const metadata = SITE_LOCALES[locale];
  const canonical = siteLocaleUrl(locale);
  const imageUrl = new URL(metadata.ogImagePath, canonical).toString();
  document.title = metadata.title;
  setMetaContent('meta[name="description"]', metadata.description);
  setMetaContent('meta[property="og:title"]', metadata.title);
  setMetaContent('meta[property="og:description"]', metadata.description);
  setMetaContent('meta[property="og:url"]', canonical);
  setMetaContent('meta[property="og:locale"]', metadata.ogLocale);
  setMetaContent('meta[property="og:image"]', imageUrl);
  setMetaContent('meta[property="og:image:alt"]', metadata.title);
  const alternateOgLocales = SITE_LOCALE_ORDER.filter((alternate) => alternate !== locale).map(
    (alternate) => SITE_LOCALES[alternate].ogLocale,
  );
  const alternateOgElements = [
    ...document.querySelectorAll<HTMLMetaElement>('meta[property="og:locale:alternate"]'),
  ];
  for (const [index, content] of alternateOgLocales.entries()) {
    const meta = alternateOgElements[index] ?? document.createElement("meta");
    meta.setAttribute("property", "og:locale:alternate");
    meta.content = content;
    if (!meta.isConnected) document.head.append(meta);
  }
  for (const staleMeta of alternateOgElements.slice(alternateOgLocales.length)) {
    staleMeta.remove();
  }
  setMetaContent('meta[name="twitter:title"]', metadata.title);
  setMetaContent('meta[name="twitter:description"]', metadata.description);
  setMetaContent('meta[name="twitter:image"]', imageUrl);
  const canonicalLink = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (canonicalLink) canonicalLink.href = canonical;
  const structuredData = document.querySelector<HTMLScriptElement>("#site-structured-data");
  if (structuredData) structuredData.textContent = JSON.stringify(siteLocaleJsonLd(locale));
}

function applyLocaleToDocument(locale: AppLocale, fontReady: boolean) {
  document.documentElement.lang = SITE_LOCALES[locale].htmlLang;
  document.documentElement.setAttribute("data-locale", locale);
  document.documentElement.setAttribute("data-locale-font-ready", String(fontReady));
  applySeoMetadata(locale);
}

function pushLocalePath(locale: AppLocale) {
  const nextPath = SITE_LOCALES[locale].path;
  if (window.location.pathname === nextPath) return;
  window.history.pushState(null, "", `${nextPath}${window.location.search}${window.location.hash}`);
}

export function prepareInitialLocale() {
  const locale = detectInitialLocale();
  applyLocaleToDocument(locale, false);
  return locale;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(detectInitialLocale);
  const localeRequestRef = useRef(0);
  useEffect(() => {
    let active = true;
    void loadRenderedLocaleFont(locale).then((fontReady) => {
      if (!active || document.documentElement.dataset["locale"] !== locale) return;
      document.documentElement.setAttribute("data-locale-font-ready", String(fontReady));
    });
    return () => {
      active = false;
    };
  }, [locale]);
  const commitLocale = useCallback(
    async (nextLocale: AppLocale, navigation: "none" | "push") => {
      const request = localeRequestRef.current + 1;
      localeRequestRef.current = request;
      if (nextLocale === locale) {
        if (navigation === "push") pushLocalePath(nextLocale);
        return;
      }
      const deadline = performance.now() + LOCALE_FONT_LOAD_TIMEOUT_MS;
      await ensureLocaleFontStylesheet(nextLocale, deadline);
      if (localeRequestRef.current !== request) return;
      if (navigation === "push") pushLocalePath(nextLocale);
      applyLocaleToDocument(nextLocale, false);
      flushSync(() => setLocaleState(nextLocale));
    },
    [locale],
  );
  const setLocale = useCallback(
    (nextLocale: AppLocale) => commitLocale(nextLocale, "push"),
    [commitLocale],
  );
  useEffect(() => {
    const syncLocaleFromPath = () => {
      void commitLocale(siteLocaleFromPathname(window.location.pathname), "none");
    };
    window.addEventListener("popstate", syncLocaleFromPath);
    return () => window.removeEventListener("popstate", syncLocaleFromPath);
  }, [commitLocale]);

  const value = useMemo<LocaleContextValue>(() => {
    const formatNumber = (number: number, digits = 2) =>
      formatNumberForLocale(locale, number, digits);
    const formatInteger = (number: number) => formatIntegerForLocale(locale, number);
    const t = (key: MessageKey, params?: MessageParams) => translate(locale, key, params);
    return {
      locale,
      setLocale,
      t,
      text: (localizedMessage) => translateMessage(locale, localizedMessage),
      formatCount: (number, unit) => {
        const labels = UNIT_LABELS[locale][unit];
        const label = Math.abs(number) === 1 ? labels[0] : labels[1];
        const formatted = formatInteger(number);
        return locale === "en" ? `${formatted} ${label}` : `${formatted}${label}`;
      },
      formatInteger,
      formatNumber,
      formatPercent: (number, digits = 2) => `${formatNumber(number * 100, digits)}%`,
    };
  }, [locale, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useI18n() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider.");
  return context;
}
