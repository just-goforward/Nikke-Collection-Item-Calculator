import { isCertifiedEventClaimable, type CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import type { PublicationBytes } from "../../shared/forecastPublicationBytes";
import type { CertifiedInput } from "../certified/types";
import type { SolverInput } from "../types";

/** Pure request projection. Forecast selection belongs to preparation, not this boundary. */
export function serviceCertifiedInput(
  input: SolverInput,
  snapshot: CertifiedSupplySnapshot,
  asOf: string,
  publication?: PublicationBytes,
  forecastSource?: "local",
): CertifiedInput {
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
    computeMinimumWait: true,
    computeWaiting: true,
    batchLimit: 10,
    autoRecommendation: true,
    riskSummary: true,
    stableRecommendation: {
      version: "experimental-stable-w-selector-v1",
      gainRiskLimit: { numerator: "1", denominator: "20" },
      repeatRiskLimit: { numerator: "1", denominator: "20" },
    },
  };
}
