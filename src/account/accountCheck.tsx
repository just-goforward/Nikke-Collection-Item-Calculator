import { useI18n } from "../i18n/locale";

/**
 * Page-load account check, shared by the main-bundle slot and the account chunk. The bound runs
 * from navigation start: inputs stay read-only for the account check at most this long.
 */
const ACCOUNT_CHECK_TIMEOUT_MS = 5_000;

export function accountCheckRemainingMs(): number {
  return Math.max(0, ACCOUNT_CHECK_TIMEOUT_MS - performance.now());
}

// Also shown before the lazy account chunk (and its catalog) has loaded.
const CHECKING_TEXT = { ko: "계정 확인 중…", en: "Checking account…", ja: "アカウントを確認中…" };

export function CheckingIndicator() {
  const { locale } = useI18n();
  return (
    <span
      className="mr-2 inline-flex min-h-[34px] items-center text-[11.5px] font-bold text-text-soft"
      role="status"
      data-account-checking
    >
      {CHECKING_TEXT[locale]}
    </span>
  );
}
