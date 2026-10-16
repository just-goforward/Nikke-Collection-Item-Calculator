import {
  type CertifiedForecastIdentity,
  certifiedForecastIdentityWorkspaceBound,
  createCertifiedForecastIdentity,
  sameCertifiedForecastIdentity,
} from "../../shared/certifiedForecastIdentity";
import {
  assertCertifiedSupplySnapshot,
  type CertifiedSupplySnapshot,
  viewCertifiedSupplySnapshot,
} from "../../shared/certifiedSupply";
import {
  type PublicationBytes,
  verifyPublicationBytes,
} from "../../shared/forecastPublicationBytes";
import {
  certifiedForecastBuildWorkspaceBound,
  prepareCertifiedForecast,
} from "./certifiedForecast";
import { runtimeForecastConfig, runtimeForecastEnabled } from "./runtimeForecastConfig";

/** Bundled authority or a publication authenticated with build-pinned keys, never
 * request-declared revision/hash. Client and Worker independently verify the proof
 * and bind exactly the submitted time-view; neither fetches a new pointer mid-run.
 */
export function trustedCertifiedForecastWorkspaceBound(
  snapshot: CertifiedSupplySnapshot,
  publication?: PublicationBytes,
): number {
  // Reserve wire strings, UTF-8 verification buffers and parsed working copies
  // before verification, without allocating a second serialization for admission.
  const wireChars = publication
    ? publication.pointer.statement.length +
      publication.pointer.signature.length +
      (publication.artifact
        ? publication.artifact.candidate.length +
          publication.artifact.authorization.statement.length +
          publication.artifact.authorization.signature.length
        : 0)
    : 0;
  return (
    certifiedForecastBuildWorkspaceBound() +
    2 * certifiedForecastIdentityWorkspaceBound(assertCertifiedSupplySnapshot(snapshot)) +
    8 * wireChars
  );
}

let highestRuntimeSequence = 0;
export async function assertTrustedCertifiedForecast(
  snapshot: CertifiedSupplySnapshot,
  accountWorkspace: (bytes: number) => void,
  publication?: PublicationBytes,
): Promise<CertifiedForecastIdentity> {
  const valid = assertCertifiedSupplySnapshot(snapshot);
  const bound = trustedCertifiedForecastWorkspaceBound(valid, publication);
  try {
    accountWorkspace(bound);
    if (publication && !runtimeForecastEnabled) throw new Error("certified_runtime_disabled");
    const approved =
      runtimeForecastEnabled && publication
        ? await verifyPublicationBytes(publication, {
            ...runtimeForecastConfig.trust,
            minimumSequence: highestRuntimeSequence,
            onPointer: (observed) => {
              if (observed < highestRuntimeSequence) throw new Error("publication_invalid_pointer");
              highestRuntimeSequence = observed;
            },
          })
        : null;
    if (approved && !approved.snapshot) throw new Error("certified_runtime_off");
    const trusted = approved?.snapshot
      ? viewCertifiedSupplySnapshot(approved.snapshot, valid.asOf)
      : await prepareCertifiedForecast(valid.asOf);
    if (
      certifiedForecastIdentityWorkspaceBound(trusted) >
      (publication ? bound : certifiedForecastBuildWorkspaceBound())
    )
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
