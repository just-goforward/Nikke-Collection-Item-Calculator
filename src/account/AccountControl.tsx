import { lazy, Suspense } from "react";
import { LazySectionErrorBoundary } from "../components/LazySectionErrorBoundary";
import type { AccountEntryProps } from "./AccountEntry";
import { accountFeatureEnabled } from "./config";

const AccountEntry = lazy(() => import("./AccountEntry"));

/**
 * Feature-flagged app-shell entry. When the flag is off nothing renders and the account chunk is
 * never requested; a failed chunk load leaves the calculator untouched (the boundary logs it).
 */
export function AccountControl(props: AccountEntryProps) {
  if (!accountFeatureEnabled()) return null;
  return (
    <LazySectionErrorBoundary name="AccountEntry" onRetry={() => undefined} fallback={() => null}>
      <Suspense fallback={null}>
        <AccountEntry {...props} />
      </Suspense>
    </LazySectionErrorBoundary>
  );
}
