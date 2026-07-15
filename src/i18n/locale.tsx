import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import type { StatsLocale } from "../../shared/statsContract";
import { ignoreExpectedError } from "../lib/errorHandling";
import { enMessages } from "./messages.en";
import { jaMessages } from "./messages.ja";
import {
  koMessages,
  type LocalizedMessage,
  type MessageKey,
  type MessageParams,
} from "./messages.ko";

export type AppLocale = StatsLocale;
type CountUnit = "attempt" | "input" | "person" | "piece" | "state" | "use";

const LANGUAGE_STORAGE_KEY = "collection-kit-calculator.language";
const LOCALE_FONT_LINK_ID = "locale-font-stylesheet";
const LOCALE_FONT_LOAD_TIMEOUT_MS = 5_000;
const LOCALE_CODES: Record<AppLocale, string> = {
  ko: "ko-KR",
  en: "en-US",
  ja: "ja-JP",
};
const FONT_STYLESHEETS: Record<AppLocale, string> = {
  ko: "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css",
  en: "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-std-dynamic-subset.min.css",
  ja: "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-jp-dynamic-subset.min.css",
};
const FONT_FAMILY_NAMES: Record<AppLocale, string> = {
  ko: "Pretendard Variable",
  en: "Pretendard Std Variable",
  ja: "Pretendard JP Variable",
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
const localeFontPromises = new Map<AppLocale, Promise<boolean>>();

export function localeFromLanguageTag(language: string | null | undefined): AppLocale | null {
  if (!language) return null;
  const normalized = language.trim().toLowerCase();
  if (normalized === "ko" || normalized.startsWith("ko-")) return "ko";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return null;
}

function browserLocale(): AppLocale {
  if (typeof document !== "undefined") {
    const documentLocale = localeFromLanguageTag(
      document.documentElement.getAttribute("data-locale"),
    );
    if (documentLocale) return documentLocale;
  }
  if (typeof navigator !== "undefined") {
    const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const language of languages) {
      const locale = localeFromLanguageTag(language);
      if (locale) return locale;
    }
  }
  return "ko";
}

export function detectInitialLocale(): AppLocale {
  if (typeof window !== "undefined") {
    try {
      const saved = localeFromLanguageTag(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
      if (saved) return saved;
    } catch (error) {
      ignoreExpectedError("language storage read can fail in restricted browser contexts", error);
    }
  }
  return browserLocale();
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

function localeFontSample(locale: AppLocale) {
  const sample = `${Object.values(MESSAGE_CATALOGS[locale]).join(" ")} 0123456789 × % R SR EXP`;
  return [...new Set(sample.replace(/\{[^}]+\}/g, ""))].join("");
}

function createLocaleFontLink(locale: AppLocale) {
  const link = document.createElement("link");
  link.id = `${LOCALE_FONT_LINK_ID}-${locale}`;
  link.setAttribute("data-locale-font", locale);
  link.setAttribute("data-load-state", "loading");
  link.rel = "stylesheet";
  link.crossOrigin = "anonymous";
  link.href = FONT_STYLESHEETS[locale];
  link.addEventListener("load", () => {
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
  if (link.getAttribute("data-load-state") === "loaded" || link.sheet) {
    return Promise.resolve(true);
  }
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

function waitForFontFace(locale: AppLocale, deadline: number) {
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
      .load(`600 1rem "${FONT_FAMILY_NAMES[locale]}"`, localeFontSample(locale))
      .then(() => finish(true))
      .catch((error: unknown) => {
        ignoreExpectedError("locale font loading can fail and use the system fallback", error);
        finish(false);
      });
  });
}

async function loadLocaleFont(locale: AppLocale) {
  const deadline = performance.now() + LOCALE_FONT_LOAD_TIMEOUT_MS;
  const stylesheetLoaded = await waitForStylesheet(localeFontLink(locale), deadline);
  if (!stylesheetLoaded) return false;
  return waitForFontFace(locale, deadline);
}

function ensureLocaleFontReady(locale: AppLocale) {
  const cached = localeFontPromises.get(locale);
  if (cached) return cached;
  const pending = loadLocaleFont(locale);
  localeFontPromises.set(locale, pending);
  void pending.then((loaded) => {
    if (!loaded && localeFontPromises.get(locale) === pending) localeFontPromises.delete(locale);
  });
  return pending;
}

function applyLocaleToDocument(locale: AppLocale, fontReady: boolean) {
  document.documentElement.lang = locale;
  document.documentElement.setAttribute("data-locale", locale);
  document.documentElement.setAttribute("data-locale-font-ready", String(fontReady));
  document.title = translate(locale, "app.title");
  const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (description) description.content = translate(locale, "app.description");
}

export async function prepareInitialLocale() {
  const locale = detectInitialLocale();
  const fontReady = await ensureLocaleFontReady(locale);
  applyLocaleToDocument(locale, fontReady);
  return locale;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(detectInitialLocale);
  const localeRequestRef = useRef(0);
  const setLocale = useCallback(
    async (nextLocale: AppLocale) => {
      const request = localeRequestRef.current + 1;
      localeRequestRef.current = request;
      if (nextLocale === locale) return;
      const fontReady = await ensureLocaleFontReady(nextLocale);
      if (localeRequestRef.current !== request) return;
      applyLocaleToDocument(nextLocale, fontReady);
      flushSync(() => setLocaleState(nextLocale));
      try {
        window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLocale);
      } catch (error) {
        ignoreExpectedError(
          "language storage write can fail in restricted browser contexts",
          error,
        );
      }
    },
    [locale],
  );

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
