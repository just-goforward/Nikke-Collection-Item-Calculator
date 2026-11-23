import { rootCandidate } from "./rootCandidate";
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
import { previewLegacyD0Enabled, previewLegacyD0Trust, runtimeForecastConfig, runtimeForecastEnabled } from "./runtimeForecastConfig";
import { readPreviewJoint } from './previewJoint.ts';
import { PREVIEW_LEGACY_FEED, PREVIEW_TIMED_FEED, previewHeadLease } from "./forecastRead";
import { PreviewSourceError } from "./previewSourceError";

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
let highestLegacySequence = 10;
function verifyTimedPublication(publication: PublicationBytes) {
  return verifyPublicationBytes(publication, {
    ...runtimeForecastConfig.trust,
    minimumSequence: highestRuntimeSequence,
    onPointer(sequence) {
      if (sequence < highestRuntimeSequence) throw new Error("publication_invalid_pointer");
      highestRuntimeSequence = sequence;
    },
  });
}
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
    if (runtimeForecastEnabled && !publication) throw new Error(NOT_APPROVED);
    const approved =
      runtimeForecastEnabled && publication
        ? await verifyTimedPublication(publication)
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

/** Narrow capability for the H14 D0 lane only. Both admissions re-read both primary heads;
 * caller-provided clocks, TTLs, keys and publication channels are never authority. */
export async function assertTrustedPreviewLegacyD0(snapshot: CertifiedSupplySnapshot, timedOff: PublicationBytes | null,
  legacy: PublicationBytes, check: () => void, workspaceBound: number, conditional = false) {
  if (!legacy.artifact || (rootCandidate ? !conditional || timedOff !== null : !previewLegacyD0Enabled || timedOff?.artifact !== null)) throw new Error(NOT_APPROVED);
  const off = timedOff && await verifyTimedPublication(timedOff);
  if (off && off.pointer.mode !== "off") throw new Error(NOT_APPROVED);
  check();
  const offUntil = timedOff && await previewHeadLease(PREVIEW_TIMED_FEED, timedOff.pointer);
  check();
  const active = await verifyPublicationBytes(legacy, {
    ...previewLegacyD0Trust, minimumSequence: highestLegacySequence,
    onPointer(sequence) {
      if (sequence < highestLegacySequence) throw new Error("publication_invalid_pointer");
      highestLegacySequence = sequence;
    },
  });
  check();
  if (!active.snapshot || (off && off.pointer.sequence !== highestRuntimeSequence)) throw new Error(NOT_APPROVED);
  if (offUntil && (performance.now() >= offUntil.until || Date.now() >= offUntil.wallUntil)) throw new PreviewSourceError('timed','expired');
  const legacyLease = await previewHeadLease(PREVIEW_LEGACY_FEED, legacy.pointer);
  const leaseUntil = Math.min(offUntil?.until ?? Infinity, legacyLease.until);
  const wallLeaseUntil = Math.min(offUntil?.wallUntil ?? Infinity, legacyLease.wallUntil);
  check();
  const base = viewCertifiedSupplySnapshot(active.snapshot, snapshot.asOf);
  const joint = conditional ? await readPreviewJoint(base,legacy,AbortSignal.timeout(5000),timedOff) : null;
  if (conditional && !joint) throw new PreviewSourceError('joint','missing');
  const trusted = joint?.snapshot ?? base;
  if (certifiedForecastIdentityWorkspaceBound(trusted) > workspaceBound) throw new Error("certified_trusted_forecast_workspace_invariant");
  const forecastIdentity = await createCertifiedForecastIdentity(snapshot);
  const trustedIdentity = await createCertifiedForecastIdentity(trusted);
  check();
  if ((off && off.pointer.sequence !== highestRuntimeSequence) || active.pointer.sequence !== highestLegacySequence) throw new Error(NOT_APPROVED);
  if (performance.now() >= leaseUntil || Date.now() >= wallLeaseUntil ||
      (joint && (performance.now() >= joint.until || Date.now() >= joint.wallUntil))) throw new PreviewSourceError('admission','expired');
  if (!sameCertifiedForecastIdentity(forecastIdentity, trustedIdentity)) {
    const prior = (rootCandidate ? /^production-conditional-([1-9]\d*)$/ : /^preview-conditional-([1-9]\d*)$/).exec(snapshot.revision);
    if (joint && prior && joint.sequence > Number(prior[1])) throw new Error("preview_source_advanced");
    throw new Error(NOT_APPROVED);
  }
  return { forecastIdentity, leaseUntil:Math.min(leaseUntil,joint?.until??Infinity),wallUntil:Math.min(wallLeaseUntil,joint?.wallUntil??Infinity) };
}
