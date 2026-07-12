import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { ignoreExpectedError } from "../lib/errorHandling";
import { enMessages } from "./messages.en";
import { jaMessages } from "./messages.ja";
import {
  koMessages,
  type LocalizedMessage,
  type MessageKey,
  type MessageParams,
} from "./messages.ko";

export type AppLocale = "ko" | "en" | "ja";
type CountUnit = "attempt" | "input" | "person" | "piece" | "state" | "use";

const LANGUAGE_STORAGE_KEY = "collection-kit-calculator.language";
const LOCALE_FONT_LINK_ID = "locale-font-stylesheet";
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
const MESSAGE_CATALOGS = {
  ko: koMessages,
  en: enMessages,
  ja: jaMessages,
} satisfies Record<AppLocale, Record<MessageKey, string>>;
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
  setLocale: (locale: AppLocale) => void;
  t: (key: MessageKey, params?: MessageParams) => string;
  text: (message: LocalizedMessage) => string;
  formatCount: (value: number, unit: CountUnit) => string;
  formatInteger: (value: number) => string;
  formatNumber: (value: number, digits?: number) => string;
  formatPercent: (value: number, digits?: number) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

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
  let result = template;
  for (const [key, value] of Object.entries(params)) {
    const formatted =
      typeof value === "number"
        ? new Intl.NumberFormat(LOCALE_CODES[locale], { maximumFractionDigits: 20 }).format(value)
        : value;
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
  return new Intl.NumberFormat(LOCALE_CODES[locale], {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

export function formatIntegerForLocale(locale: AppLocale, value: number) {
  return new Intl.NumberFormat(LOCALE_CODES[locale], { maximumFractionDigits: 0 }).format(value);
}

function applyLocaleToDocument(locale: AppLocale) {
  document.documentElement.lang = locale;
  document.documentElement.setAttribute("data-locale", locale);
  document.title = translate(locale, "app.title");
  const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (description) description.content = translate(locale, "app.description");
  const fontLink = document.getElementById(LOCALE_FONT_LINK_ID);
  if (fontLink instanceof HTMLLinkElement && fontLink.href !== FONT_STYLESHEETS[locale]) {
    fontLink.href = FONT_STYLESHEETS[locale];
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(detectInitialLocale);
  const setLocale = useCallback((nextLocale: AppLocale) => {
    setLocaleState(nextLocale);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLocale);
    } catch (error) {
      ignoreExpectedError("language storage write can fail in restricted browser contexts", error);
    }
  }, []);

  useEffect(() => applyLocaleToDocument(locale), [locale]);

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
