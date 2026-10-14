import { lazy, Suspense, useEffect, useRef } from "react";
import { LazySectionErrorBoundary } from "../components/LazySectionErrorBoundary";
import type { AccountControlProps } from "./accountBinding";
import { accountCheckRemainingMs, CheckingIndicator, redirectRestorePending } from "./accountCheck";

/**
 * Feature-flagged app-shell slot. With accountCheck.tsx and config.ts it is the only account code
 * in the main bundle. Shells render it only when `accountFeatureEnabled()` is true; with the flag
 * off nothing here runs and the account chunk (controller, lock, dialogs, certified adapter) is
 * never requested.
 */

const loadEntry = () => lazy(() => import("./AccountEntry"));
let entry: ReturnType<typeof loadEntry> | null = null;

/**
 * Until the chunk loads; past the bound it releases the inputs on its own, unless guest inputs
 * saved before a sign-in redirect await restoring: only the chunk can restore them, so the inputs
 * stay read-only until it has loaded (it restores, then releases) or failed (released at once).
 * Releasing first would let the late restore replace edits made since, or lose the saved inputs.
 */
function LoadingFallback({ onTimeout }: { onTimeout: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onTimeout, accountCheckRemainingMs());
    return () => window.clearTimeout(timer);
  }, [onTimeout]);
  return <CheckingIndicator />;
}

/** Without the account chunk nothing can resolve the check: guest data unlocks at once. */
function ReleaseOnFailure({ onLockChange }: { onLockChange: (locked: boolean) => void }) {
  useEffect(() => onLockChange(false), [onLockChange]);
  return null;
}

export function AccountControl(props: AccountControlProps) {
  const fellBack = useRef(false);
  const { onLockChange } = props;
  entry ??= loadEntry();
  const Entry = entry;
  return (
    <LazySectionErrorBoundary
      name="AccountEntry"
      onRetry={() => undefined}
      fallback={() => <ReleaseOnFailure onLockChange={onLockChange} />}
    >
      <Suspense
        fallback={
          <LoadingFallback
            onTimeout={() => {
              if (redirectRestorePending()) return;
              fellBack.current = true;
              onLockChange(false);
            }}
          />
        }
      >
        <Entry {...props} bootFellBack={fellBack} />
      </Suspense>
    </LazySectionErrorBoundary>
  );
}
