import { isCertifiedEventClaimable, type CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import type { PublicationBytes } from "../../shared/forecastPublicationBytes";
import type { ServiceH14Input } from "../serviceH14/types";
import type { SolverInput } from "../types";

/** Pure request projection. Forecast selection belongs to preparation, not this boundary. */
export function serviceCertifiedInput(
  input: SolverInput,
  snapshot: CertifiedSupplySnapshot,
  asOf: string,
  publication?: PublicationBytes,
  forecastSource?: "local",
  legacyD0?: ServiceH14Input["legacyD0"],
): ServiceH14Input {
  return {
    ...input.start,
    stock: [input.stock.blue, input.stock.purple, input.stock.yellow],
    snapshot,
    asOf,
    ...(publication ? { forecastPublication: publication } :
      forecastSource ? { forecastSource } : {}),
    // Approved service convention: stock includes ALL rewards claimable at this bound time.
    // No reward addition, fabricated receipts, storage or inferred cohort posterior.
    receivedEventIds: snapshot.events
      .filter((event) => isCertifiedEventClaimable(snapshot, event, asOf))
      .map((event) => event.id),
    ...(legacyD0 ? { legacyD0 } : {}),
    computeMinimumWait: !legacyD0,
    computeWaiting: !legacyD0,
    batchLimit: 10,
    riskSummary: true,
  };
}
