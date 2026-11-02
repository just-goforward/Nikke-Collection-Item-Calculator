import {
  type CertifiedSupplySnapshot,
  viewCertifiedSupplySnapshot,
} from "../../shared/certifiedSupply";
import { CERTIFIED_LOCAL_FORECAST_POLICY } from "../../shared/generated/certifiedLocalForecast";
import { approvedCertifiedSnapshot } from "./certifiedForecast";
import { localCertifiedForecastEnabled } from "./certifiedLocalPolicy";

/** A build-pinned unsigned policy; it is not an approved collector publication. */
export function localCertifiedSnapshot(): CertifiedSupplySnapshot {
  if (!localCertifiedForecastEnabled()) throw new Error("certified_local_policy_disabled");
  const approved = approvedCertifiedSnapshot();
  // The generator validates this exact static delta; the approved base is validated above.
  // Incoming requests are independently validated and identity-bound on both sides.
  return {
    ...approved,
    version: CERTIFIED_LOCAL_FORECAST_POLICY.version,
    revision: CERTIFIED_LOCAL_FORECAST_POLICY.revision,
    provenance: [...approved.provenance, ...CERTIFIED_LOCAL_FORECAST_POLICY.provenanceSuffix],
  };
}

export async function prepareLocalCertifiedForecast(
  asOf = new Date().toISOString(),
): Promise<CertifiedSupplySnapshot> {
  return viewCertifiedSupplySnapshot(localCertifiedSnapshot(), asOf);
}
