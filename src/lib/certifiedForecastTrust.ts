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
import { localCertifiedSnapshot, prepareLocalCertifiedForecast } from "./certifiedLocalForecast";
import { localCertifiedForecastEnabled } from "./certifiedLocalPolicy";
import { runtimeForecastConfig, runtimeForecastEnabled } from "./runtimeForecastConfig";

/** Approved authority/publication by default; unsigned local policy requires an explicit
 * marker and is forbidden in publication mode. Client and Worker bind the selected
 * compiled input independently, never a request-declared revision/hash.
 */
export function trustedCertifiedForecastWorkspaceBound(
  snapshot: CertifiedSupplySnapshot,
  publication?: PublicationBytes,
  source?: "local",
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
    bundledWorkspaceBound(source) +
    2 * certifiedForecastIdentityWorkspaceBound(assertCertifiedSupplySnapshot(snapshot)) +
    8 * wireChars
  );
}

let highestRuntimeSequence = 0;
const NOT_APPROVED = "certified_forecast_not_approved";
function bundledWorkspaceBound(source?: "local") {
  return certifiedForecastBuildWorkspaceBound(
    source === "local" ? localCertifiedSnapshot() : undefined,
  );
}
function assertForecastSource(source: unknown, publication?: PublicationBytes): void {
  if (
    source !== undefined &&
    (source !== "local" ||
      !localCertifiedForecastEnabled() ||
      runtimeForecastEnabled ||
      publication)
  )
    throw new Error(NOT_APPROVED);
}
export async function assertTrustedCertifiedForecast(
  snapshot: CertifiedSupplySnapshot,
  accountWorkspace: (bytes: number) => void,
  publication?: PublicationBytes,
  source?: "local",
): Promise<CertifiedForecastIdentity> {
  assertForecastSource(source, publication);
  const valid = assertCertifiedSupplySnapshot(snapshot);
  const bound = trustedCertifiedForecastWorkspaceBound(valid, publication, source);
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
      : await (source === "local" ? prepareLocalCertifiedForecast : prepareCertifiedForecast)(
          valid.asOf,
        );
    if (
      certifiedForecastIdentityWorkspaceBound(trusted) >
      (publication ? bound : bundledWorkspaceBound(source))
    )
      throw new Error("certified_trusted_forecast_workspace_invariant");
    const incomingIdentity = await createCertifiedForecastIdentity(valid);
    const trustedIdentity = await createCertifiedForecastIdentity(trusted);
    if (!sameCertifiedForecastIdentity(incomingIdentity, trustedIdentity))
      throw new Error(NOT_APPROVED);
    return incomingIdentity;
  } finally {
    accountWorkspace(0);
  }
}
