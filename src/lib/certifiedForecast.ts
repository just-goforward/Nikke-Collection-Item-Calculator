import { certifiedForecastIdentityWorkspaceBound } from "../../shared/certifiedForecastIdentity";
import {
  assertCertifiedRuntimeSupplySnapshot,
  type CertifiedSupplySnapshot,
  viewCertifiedSupplySnapshot,
} from "../../shared/certifiedSupply";
import { CERTIFIED_APPROVED_FORECAST } from "../../shared/generated/certifiedForecastAuthority";

export function approvedCertifiedSnapshot(): CertifiedSupplySnapshot {
  return assertCertifiedRuntimeSupplySnapshot(CERTIFIED_APPROVED_FORECAST.certifiedSnapshot);
}

/** Account for the adopted ledger; viewing it never generates additional authority. */
export function certifiedForecastBuildWorkspaceBound(
  snapshot = approvedCertifiedSnapshot(),
): number {
  return 4 * 1024 * 1024 + 8 * certifiedForecastIdentityWorkspaceBound(snapshot);
}

export async function prepareCertifiedForecast(
  asOf = new Date().toISOString(),
): Promise<CertifiedSupplySnapshot> {
  return viewCertifiedSupplySnapshot(approvedCertifiedSnapshot(), asOf);
}
