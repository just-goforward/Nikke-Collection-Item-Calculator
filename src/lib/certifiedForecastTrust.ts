import {
  type CertifiedForecastIdentity,
  certifiedForecastIdentityWorkspaceBound,
  createCertifiedForecastIdentity,
  sameCertifiedForecastIdentity,
} from "../../shared/certifiedForecastIdentity";
import {
  assertCertifiedSupplySnapshot,
  type CertifiedSupplySnapshot,
} from "../../shared/certifiedSupply";
import {
  certifiedForecastBuildWorkspaceBound,
  prepareCertifiedForecast,
} from "./certifiedForecast";

/** The trusted source is shipped approved data, not request-declared revision/hash.
 * The build guard pins the approved registry, original notice bytes and provider.
 * Client and Worker each reconstruct and hash their own allowed snapshot.
 */
export function trustedCertifiedForecastWorkspaceBound(snapshot: CertifiedSupplySnapshot): number {
  return (
    certifiedForecastBuildWorkspaceBound() +
    2 * certifiedForecastIdentityWorkspaceBound(assertCertifiedSupplySnapshot(snapshot))
  );
}

export async function assertTrustedCertifiedForecast(
  snapshot: CertifiedSupplySnapshot,
  accountWorkspace: (bytes: number) => void,
): Promise<CertifiedForecastIdentity> {
  const valid = assertCertifiedSupplySnapshot(snapshot);
  const bound = trustedCertifiedForecastWorkspaceBound(valid);
  try {
    accountWorkspace(bound);
    const trusted = await prepareCertifiedForecast(valid.asOf);
    if (certifiedForecastIdentityWorkspaceBound(trusted) > certifiedForecastBuildWorkspaceBound())
      throw new Error("certified_trusted_forecast_workspace_invariant");
    const incomingIdentity = await createCertifiedForecastIdentity(valid);
    const trustedIdentity = await createCertifiedForecastIdentity(trusted);
    if (!sameCertifiedForecastIdentity(incomingIdentity, trustedIdentity))
      throw new Error("certified_forecast_not_approved");
    return incomingIdentity;
  } finally {
    accountWorkspace(0);
  }
}
