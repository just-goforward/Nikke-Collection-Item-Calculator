import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../../shared/certifiedEngineProfile";
import {
  type CertifiedSupplySnapshot,
  isCertifiedEventClaimable,
} from "../../shared/certifiedSupply";
import type { CertifiedSession } from "./session";

/** One in-memory result only; not stock forecasting or persistent result storage.
 * Bind every numerical/claim input while ignoring only the preparation timestamp.
 */
export function certifiedRunCacheKey(
  session: CertifiedSession,
  snapshot: CertifiedSupplySnapshot,
  asOf: string,
): string {
  return JSON.stringify({
    engine: CERTIFIED_STAGING_ENGINE_PROFILE,
    id: session.id,
    state: session.state,
    stock: session.stock,
    cohortWeights: session.cohortWeights,
    received: session.receipts.map((receipt) => receipt.eventId),
    snapshot: { ...snapshot, asOf: undefined },
    claimable: snapshot.events
      .filter((event) => isCertifiedEventClaimable(snapshot, event, asOf))
      .map((event) => event.id),
  });
}
