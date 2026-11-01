import type { SolverResult } from "../hooks/calculatorShared";
import type { CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import type { PublicationBytes } from "../../shared/forecastPublicationBytes";
import type { SolverInput } from "../types";
import { BANDS, type Bands } from "../../shared/decisionAnalyticsV3";
import type { normalizePublishedSupplyReference, selectPublishedSupplyReference, PublicSupplyReference } from "../../shared/decisionSupplyReference";
import type { SupplyForecastCandidate } from "../../shared/supplyForecastCandidate";

export type PublicAcquisition = Readonly<{
  contentHash: string; runtimeSnapshotHash: string; asOf: string;
}>;
const acquisitions = new WeakMap<SolverResult, PublicAcquisition>();
const requestedInputs = new WeakSet<SolverInput>();
const signedMappings = new WeakMap<PublicAcquisition, Bands>();
const publicReferences = new WeakMap<PublicAcquisition, PublicSupplyReference>();
export function verifiedPublicReference(actual: PublicAcquisition) {
  return publicReferences.get(actual);
}
export type VerifiedMappingInput = Readonly<{
  actual: PublicAcquisition;
  snapshot: CertifiedSupplySnapshot;
  signedCandidate: unknown;
}>;
/** The approved public derivation is installed by bootstrap, never by URL input. */
export type VerifiedDecisionMapping = (input: VerifiedMappingInput) => Bands | undefined;
let verifiedMapping: VerifiedDecisionMapping | undefined;
const requestedMappings = new WeakMap<SolverInput, VerifiedDecisionMapping>();
export function installVerifiedDecisionMapping(mapping: VerifiedDecisionMapping | undefined) {
  verifiedMapping = mapping;
}
export function decisionMappingConfigured() {
  return typeof verifiedMapping === "function";
}
export function verifiedAcquisitionSupply(actual: PublicAcquisition) {
  return signedMappings.get(actual);
}
export function requestDecisionAcquisition(input: SolverInput) {
  requestedInputs.add(input);
  if (verifiedMapping) requestedMappings.set(input, verifiedMapping);
}

/** Called only after the existing client has validated the exact request/publication/output. */
export function retainVerifiedAcquisition(
  result: SolverResult, snapshot: CertifiedSupplySnapshot, publication: PublicationBytes | undefined, asOf: string,
  originalInput: SolverInput,
  projection: {
    select: typeof selectPublishedSupplyReference;
    normalize: typeof normalizePublishedSupplyReference;
  },
) {
  try {
    if (!requestedInputs.has(originalInput)) return;
    if (!publication?.artifact || !result.certified) return;
    const pointer = JSON.parse(publication.pointer.statement);
    const authorization = JSON.parse(publication.artifact.authorization.statement);
    const identity = result.certified.output.runtimeBinding.forecastIdentity;
    if (pointer.mode !== "active" || typeof pointer.contentHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(pointer.contentHash) ||
        authorization.contentHash !== pointer.contentHash ||
        authorization.candidateId !== pointer.candidateId ||
        identity.sourceHash !== snapshot.sourceHash || identity.snapshotRevision !== snapshot.revision)
      return;
    const actual = Object.freeze({
      contentHash: pointer.contentHash, runtimeSnapshotHash: identity.snapshotHash, asOf,
    });
    const source = {
      publicationContentHash: pointer.contentHash,
      candidate: JSON.parse(publication.artifact.candidate) as SupplyForecastCandidate,
    };
    const reference = projection.select(source, Date.parse(asOf));
    publicReferences.set(actual, projection.normalize(source, reference).reference);
    acquisitions.set(result, actual);
    // Pin the derivation at request start, not after a later provider refresh.
    const mapping = requestedMappings.get(originalInput);
    const supply = mapping?.({
      actual, snapshot,
      signedCandidate: JSON.parse(publication.artifact.candidate),
    });
    if (supply && Object.keys(supply).length === 3 &&
        [supply.blue, supply.purple, supply.yellow].every(band => BANDS.includes(band)))
      signedMappings.set(actual, Object.freeze({ ...supply }));
  } catch {
    // An observation failure cannot change a validated calculation result.
  }
}
export function acquisitionForResult(result: SolverResult) {
  return acquisitions.get(result);
}
