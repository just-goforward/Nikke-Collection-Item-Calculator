import { assertCertifiedRuntimeSupplySnapshot } from "./certifiedSupply.ts";
import { isPublicationVersionPair } from "./certifiedVersionPolicy.ts";
export const ARTIFACT_DOMAIN = "nikke.forecast.artifact.v1";
export const POINTER_DOMAIN = "nikke.forecast.pointer.v1";
export type PublicationEnvironment = "staging" | "production";
export type ArtifactStatement = {
  domain: typeof ARTIFACT_DOMAIN;
  environment: PublicationEnvironment;
  keyId: string;
  candidateId: string;
  contentHash: string;
};
export type PointerStatement = {
  domain: typeof POINTER_DOMAIN;
  environment: PublicationEnvironment;
  keyId: string;
  sequence: number;
  mode: "active" | "off";
  candidateId: string | null;
  contentHash: string | null;
  operationId: string;
  issuedAt: number;
};
export type SignedPublicationBytes = { statement: string; signature: string };
export type PublicationBytes = {
  pointer: SignedPublicationBytes;
  artifact: { authorization: SignedPublicationBytes; candidate: string } | null;
};
export type PublicationByteTrust = {
  environment: PublicationEnvironment;
  keyId: string;
  publicKeyBase64: string;
  minimumSequence: number;
  onPointer?: (sequence: number) => void;
};

/** Failed artifact admission keeps an exclusive floor. Only complete admission
 * permits equal-sequence refreshes again; a late completion cannot lower the floor.
 */
export function createPublicationSequenceGuard() {
  let highest = 0;
  let minimum = 0;
  return {
    get minimumSequence() {
      return minimum;
    },
    observe(sequence: number) {
      if (sequence < minimum) throw new Error("publication_invalid_pointer");
      highest = sequence;
      minimum = sequence + 1;
    },
    accept(sequence: number) {
      if (sequence !== highest) throw new Error("publication_invalid_pointer");
      minimum = sequence;
    },
  };
}

export function decodePublicationBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || !value)
    throw new Error("publication_invalid_base64");
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export async function publicationBytesHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyPublicationSignature(signed: SignedPublicationBytes, key: CryptoKey) {
  fields(signed, "signature,statement");
  if (
    typeof signed.statement !== "string" ||
    !(await crypto.subtle.verify(
      "Ed25519",
      key,
      decodePublicationBase64(signed.signature),
      new TextEncoder().encode(signed.statement),
    ))
  )
    throw new Error("publication_invalid_signature");
}

function fields(value: object, expected: string) {
  if (Object.keys(value).sort().join(",") !== expected)
    throw new Error("publication_invalid_fields");
}

/** Signatures authenticate the exact UTF-8 statements, not reserialized JSON.
 * The artifact signature authenticates its statement (including the content hash);
 * it is NOT a signature directly over the candidate. Candidate validation/derivation
 * is the publisher's sealed admission contract. The deployed snapshot validator is
 * still mandatory here; profiles are never consumed as authority.
 */
export async function verifyPublicationBytes(value: PublicationBytes, trust: PublicationByteTrust) {
  const key = await crypto.subtle.importKey(
    "raw",
    decodePublicationBase64(trust.publicKeyBase64),
    "Ed25519",
    false,
    ["verify"],
  );
  await verifyPublicationSignature(value.pointer, key);
  const pointer: PointerStatement = JSON.parse(value.pointer.statement);
  assertPointer(pointer, trust);
  assertPointerTarget(pointer);
  trust.onPointer?.(pointer.sequence);
  fields(value, "artifact,pointer");
  if (pointer.mode === "off") {
    if (value.artifact !== null) throw new Error("publication_invalid_off");
    return { pointer, snapshot: null };
  }
  if (pointer.mode !== "active" || !value.artifact) throw new Error("publication_invalid_mode");
  return { pointer, snapshot: await verifyArtifactBytes(value.artifact, pointer, trust, key) };
}

function assertPointerTarget(pointer: PointerStatement) {
  if (pointer.mode === "off") {
    if (pointer.candidateId !== null || pointer.contentHash !== null)
      throw new Error("publication_invalid_off");
  } else if (
    pointer.mode !== "active" ||
    typeof pointer.candidateId !== "string" ||
    !/^forecast-[a-z0-9-]{8,120}$/.test(pointer.candidateId) ||
    typeof pointer.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(pointer.contentHash)
  )
    throw new Error("publication_invalid_pointer");
}

function assertPointer(pointer: PointerStatement, trust: PublicationByteTrust) {
  fields(
    pointer,
    "candidateId,contentHash,domain,environment,issuedAt,keyId,mode,operationId,sequence",
  );
  if (
    !Number.isSafeInteger(trust.minimumSequence) ||
    trust.minimumSequence < 0 ||
    pointer.domain !== POINTER_DOMAIN ||
    pointer.environment !== trust.environment ||
    pointer.keyId !== trust.keyId ||
    !Number.isSafeInteger(pointer.sequence) ||
    pointer.sequence < Math.max(1, trust.minimumSequence) ||
    !Number.isSafeInteger(pointer.issuedAt) ||
    pointer.issuedAt <= 0 ||
    typeof pointer.operationId !== "string" ||
    !/^\d{1,24}$/.test(pointer.operationId)
  )
    throw new Error("publication_invalid_pointer");
}

async function verifyArtifactBytes(
  value: NonNullable<PublicationBytes["artifact"]>,
  pointer: PointerStatement,
  trust: PublicationByteTrust,
  key: CryptoKey,
) {
  fields(value, "authorization,candidate");
  const { authorization, candidate: bytes } = value;
  await verifyPublicationSignature(authorization, key);
  const artifact: ArtifactStatement = JSON.parse(authorization.statement);
  fields(artifact, "candidateId,contentHash,domain,environment,keyId");
  if (
    typeof bytes !== "string" ||
    artifact.domain !== ARTIFACT_DOMAIN ||
    artifact.environment !== trust.environment ||
    artifact.keyId !== trust.keyId ||
    artifact.candidateId !== pointer.candidateId ||
    artifact.contentHash !== pointer.contentHash ||
    (await publicationBytesHash(bytes)) !== pointer.contentHash
  )
    throw new Error("publication_artifact_mismatch");
  const candidate = JSON.parse(bytes);
  if (
    !isPublicationVersionPair(candidate.payloadVersion, candidate.rulesVersion) ||
    candidate.candidateId !== pointer.candidateId ||
    !["crosschecked", "x_unavailable"].includes(candidate.sourceStatus)
  )
    throw new Error("publication_unsupported_rules");
  return assertCertifiedRuntimeSupplySnapshot(candidate.certifiedSnapshot);
}
