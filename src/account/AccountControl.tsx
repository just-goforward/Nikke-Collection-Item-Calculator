import { lazy, Suspense, useEffect } from "react";
import { LazySectionErrorBoundary } from "../components/LazySectionErrorBoundary";
import { useI18n } from "../i18n/locale";
import type { AccountEntryProps } from "./AccountEntry";
import { accountBootGate, useAccountBootLocked } from "./bootGate";
import { accountFeatureEnabled } from "./config";

const AccountEntry = lazy(() => import("./AccountEntry"));

// Shown before the lazy account chunk (and its catalog) has loaded.
const CHECKING_TEXT = { ko: "계정 확인 중…", en: "Checking account…", ja: "アカウントを確認中…" };

function CheckingIndicator() {
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

/** Without the account chunk nothing can resolve the check: guest data unlocks at once. */
function ReleaseOnFailure() {
  useEffect(() => accountBootGate().release(), []);
  return null;
}

/**
 * Feature-flagged app-shell entry. When the flag is off nothing renders and the account chunk is
 * never requested; a failed chunk load leaves the calculator untouched (the boundary logs it).
 */
export function AccountControl(props: AccountEntryProps) {
  const checking = useAccountBootLocked();
  if (!accountFeatureEnabled()) return null;
  return (
    <>
      {checking ? <CheckingIndicator /> : null}
      <LazySectionErrorBoundary
        name="AccountEntry"
        onRetry={() => undefined}
        fallback={() => <ReleaseOnFailure />}
      >
        <Suspense fallback={null}>
          <AccountEntry {...props} />
        </Suspense>
      </LazySectionErrorBoundary>
    </>
  );
}
