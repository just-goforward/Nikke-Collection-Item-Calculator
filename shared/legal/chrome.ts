import type { SiteLocale } from "../siteLocales.ts";

/** Page chrome shared by every static legal page. */
export const LEGAL_CHROME = {
  ko: { back: "← 계산기로 돌아가기", placeholderLabel: "입력 예정" },
  en: { back: "← Back to the calculator", placeholderLabel: "To be supplied" },
  ja: { back: "← 計算機に戻る", placeholderLabel: "記入予定" },
} as const satisfies Record<SiteLocale, { back: string; placeholderLabel: string }>;
