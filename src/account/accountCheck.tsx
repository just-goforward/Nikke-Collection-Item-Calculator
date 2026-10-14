import { useI18n } from "../i18n/locale";

/**
 * Page-load account check, shared by the main-bundle slot and the account chunk. The bound runs
 * from navigation start: inputs stay read-only for the account check at most this long.
 */
const ACCOUNT_CHECK_TIMEOUT_MS = 5_000;

export function accountCheckRemainingMs(): number {
  return Math.max(0, ACCOUNT_CHECK_TIMEOUT_MS - performance.now());
}

/**
 * Per-tab marker (sessionStorage survives the sign-in redirect round trip) set while guest inputs
 * saved before a sign-in redirect await restoring. Only the account chunk can restore them, so the
 * slot keeps the inputs read-only past the bound until that chunk has loaded (or failed to load).
 */
export const REDIRECT_RESTORE_KEY = "collection-kit-account:restore-pending";

/** False also when storage is disabled: the marker could not have been set either. */
export function redirectRestorePending(): boolean {
  try {
    return sessionStorage.getItem(REDIRECT_RESTORE_KEY) !== null;
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    return false;
  }
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
