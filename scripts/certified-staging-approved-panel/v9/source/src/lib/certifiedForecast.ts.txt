import { certifiedForecastIdentityWorkspaceBound } from "../../shared/certifiedForecastIdentity";
import {
  assertCertifiedRuntimeSupplySnapshot,
  type CertifiedSupplySnapshot,
  viewCertifiedSupplySnapshot,
} from "../../shared/certifiedSupply";
import { CERTIFIED_APPROVED_FORECAST } from "../../shared/generated/certifiedForecastAuthority";

function bundledSnapshot(): CertifiedSupplySnapshot {
  return assertCertifiedRuntimeSupplySnapshot(
    Reflect.get(CERTIFIED_APPROVED_FORECAST, "certifiedSnapshot"),
  );
}

/** Account for the adopted ledger; viewing it never generates additional authority. */
export function certifiedForecastBuildWorkspaceBound(): number {
  return 4 * 1024 * 1024 + 8 * certifiedForecastIdentityWorkspaceBound(bundledSnapshot());
}

export async function prepareCertifiedForecast(
  asOf = new Date().toISOString(),
): Promise<CertifiedSupplySnapshot> {
  return viewCertifiedSupplySnapshot(bundledSnapshot(), asOf);
}
