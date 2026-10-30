import type { SolverResult } from "../hooks/calculatorShared";
import type { CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import type { PublicationBytes } from "../../shared/forecastPublicationBytes";
import type { SolverInput } from "../types";

export type PublicAcquisition = Readonly<{
  contentHash: string; runtimeSnapshotHash: string; asOf: string;
}>;
const acquisitions = new WeakMap<SolverResult, PublicAcquisition>();
const requestedInputs = new WeakSet<SolverInput>();
export function requestDecisionAcquisition(input: SolverInput) {
  requestedInputs.add(input);
}

/** Called only after the existing client has validated the exact request/publication/output. */
export function retainVerifiedAcquisition(
  result: SolverResult, snapshot: CertifiedSupplySnapshot, publication: PublicationBytes | undefined, asOf: string,
  originalInput: SolverInput,
) {
  try {
    if (!requestedInputs.delete(originalInput)) return;
    if (!publication?.artifact || result.certified?.final !== true) return;
    const pointer = JSON.parse(publication.pointer.statement);
    const authorization = JSON.parse(publication.artifact.authorization.statement);
    const identity = result.certified.output.runtimeBinding.forecastIdentity;
    if (pointer.mode !== "active" || typeof pointer.contentHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(pointer.contentHash) ||
        authorization.contentHash !== pointer.contentHash ||
        authorization.candidateId !== pointer.candidateId ||
        identity.sourceHash !== snapshot.sourceHash || identity.snapshotRevision !== snapshot.revision)
      return;
    acquisitions.set(result, Object.freeze({
      contentHash: pointer.contentHash, runtimeSnapshotHash: identity.snapshotHash, asOf,
    }));
  } catch {
    // An observation failure cannot change a validated calculation result.
  }
}
export function acquisitionForResult(result: SolverResult) {
  return acquisitions.get(result);
}
