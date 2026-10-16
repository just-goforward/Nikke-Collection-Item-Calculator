import { assertCertifiedRuntimeSupplySnapshot } from "./certifiedSupply.ts";
import {
  buildV3SupplyForecastCandidate,
  type SupplyForecastCandidate,
} from "./supplyForecastCandidate.ts";

export type PublicationEnvironment = "staging" | "production";
export const ARTIFACT_DOMAIN = "nikke.forecast.artifact.v1";
export const POINTER_DOMAIN = "nikke.forecast.pointer.v1";

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
export type Signed<T> = { statement: T; signature: string };
export type PublicationEnvelope = {
  pointer: Signed<PointerStatement>;
  artifact: { authorization: Signed<ArtifactStatement>; candidate: SupplyForecastCandidate } | null;
};

/** JSON-only, UTF-16 code-unit key order; arrays retain order; no whitespace.
 * SHA-256 and Ed25519 always consume UTF-8 of this serialization. No locale sorting.
 * Unsupported JSON values are rejected, not silently omitted.
 */
export function canonicalPublicationJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalPublicationJson).join(",")}]`;
  if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalPublicationJson(Reflect.get(value, key))}`)
      .join(",")}}`;
  }
  throw new Error("publication_not_json");
}

export async function publicationHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes(canonicalPublicationJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function publicationCandidate(value: unknown): SupplyForecastCandidate {
  const raw = object(value);
  if (raw["payloadVersion"] !== 4 || raw["rulesVersion"] !== "schedule-kit-v3")
    throw new Error("publication_unsupported_rules");
  if (typeof raw["forecastId"] !== "string") throw new Error("publication_forecast_id");
  // Construct the ledger-derived profiles once, then compare the complete canonical
  // candidate. The builder performs the same schema/content checks; equality retains
  // exact profile validation and rejects unknown fields without deriving twice.
  const candidate = buildV3SupplyForecastCandidate({
    ...raw,
    forecastId: raw["forecastId"],
    certifiedSnapshot: assertCertifiedRuntimeSupplySnapshot(raw["certifiedSnapshot"]),
  });
  if (candidate.sourceStatus === "conflict") throw new Error("publication_conflicting_sources");
  if (canonicalPublicationJson(candidate) !== canonicalPublicationJson(value))
    throw new Error("publication_unknown_fields");
  return candidate;
}

/** Router secret: standard base64 DER PKCS#8 Ed25519 private key, no PEM headers.
 * keyId is a public identifier, pinned with the raw public key by the consumer.
 */
export function importPublicationSigningKey(pkcs8Base64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", decodeBase64(pkcs8Base64), "Ed25519", false, ["sign"]);
}

export async function signPublication<T extends ArtifactStatement | PointerStatement>(
  statement: T,
  key: CryptoKey,
): Promise<Signed<T>> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key,
    bytes(canonicalPublicationJson(statement)),
  );
  return { statement, signature: encodeBase64(new Uint8Array(signature)) };
}

/** Throws on malformed, unsupported, tampered, wrong-environment/key or stale data.
 * minimumSequence is the highest authenticated sequence observed in THIS environment.
 * Equal sequence is permitted for cache refresh; a lower sequence (including old "off") is not.
 * Sequence zero is deliberately unsigned/unservable. Key discovery from the response is forbidden.
 */
type PublicationTrust = {
  environment: PublicationEnvironment;
  keyId: string;
  publicKeyBase64: string;
  minimumSequence: number;
};

export async function verifyPublication(
  value: unknown,
  trust: PublicationTrust,
): Promise<PublicationEnvelope> {
  if (!Number.isSafeInteger(trust.minimumSequence) || trust.minimumSequence < 0)
    throw new Error("publication_invalid_minimum_sequence");
  const envelope = object(value);
  exactKeys(envelope, ["pointer", "artifact"]);
  const pointer = signedObject(envelope["pointer"]);
  const state = pointer.statement;
  exactKeys(state, [
    "domain",
    "environment",
    "keyId",
    "sequence",
    "mode",
    "candidateId",
    "contentHash",
    "operationId",
    "issuedAt",
  ]);
  const publicKey = await crypto.subtle.importKey(
    "raw",
    decodeBase64(trust.publicKeyBase64),
    "Ed25519",
    false,
    ["verify"],
  );
  assertPointerStatement(state, trust);
  await verifySignature(pointer, publicKey);
  if (state["mode"] === "off") {
    if (
      state["candidateId"] !== null ||
      state["contentHash"] !== null ||
      envelope["artifact"] !== null
    )
      throw new Error("publication_invalid_off");
  } else if (state["mode"] === "active") {
    await verifyArtifact(envelope["artifact"], state, trust, publicKey);
  } else {
    throw new Error("publication_invalid_mode");
  }
  return value as PublicationEnvelope;
}

function assertPointerStatement(state: Record<string, unknown>, trust: PublicationTrust) {
  if (
    state["domain"] !== POINTER_DOMAIN ||
    state["environment"] !== trust.environment ||
    state["keyId"] !== trust.keyId ||
    !Number.isSafeInteger(state["sequence"]) ||
    Number(state["sequence"]) < Math.max(1, trust.minimumSequence) ||
    !Number.isSafeInteger(state["issuedAt"]) ||
    Number(state["issuedAt"]) <= 0 ||
    typeof state["operationId"] !== "string" ||
    !/^\d{1,24}$/.test(state["operationId"])
  )
    throw new Error("publication_invalid_pointer");
}

async function verifyArtifact(
  value: unknown,
  state: Record<string, unknown>,
  trust: PublicationTrust,
  publicKey: CryptoKey,
) {
  const artifact = object(value);
  exactKeys(artifact, ["authorization", "candidate"]);
  const authorization = signedObject(artifact["authorization"]);
  exactKeys(authorization.statement, [
    "domain",
    "environment",
    "keyId",
    "candidateId",
    "contentHash",
  ]);
  const candidate = publicationCandidate(artifact["candidate"]);
  const hash = await publicationHash(candidate);
  if (
    authorization.statement["domain"] !== ARTIFACT_DOMAIN ||
    authorization.statement["environment"] !== trust.environment ||
    authorization.statement["keyId"] !== trust.keyId ||
    authorization.statement["candidateId"] !== candidate.candidateId ||
    authorization.statement["contentHash"] !== hash ||
    state["candidateId"] !== candidate.candidateId ||
    state["contentHash"] !== hash
  )
    throw new Error("publication_artifact_mismatch");
  await verifySignature(authorization, publicKey);
}

export function encodeBase64(value: Uint8Array): string {
  return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""));
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || !value)
    throw new Error("publication_invalid_base64");
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function bytes(value: string) {
  return new TextEncoder().encode(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("publication_invalid_object");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join(",") !== keys.sort().join(","))
    throw new Error("publication_invalid_fields");
}
function signedObject(value: unknown) {
  const signed = object(value);
  exactKeys(signed, ["statement", "signature"]);
  if (typeof signed["signature"] !== "string") throw new Error("publication_invalid_signature");
  return { statement: object(signed["statement"]), signature: signed["signature"] };
}
async function verifySignature(signed: { statement: object; signature: string }, key: CryptoKey) {
  if (
    !(await crypto.subtle.verify(
      "Ed25519",
      key,
      decodeBase64(signed.signature),
      bytes(canonicalPublicationJson(signed.statement)),
    ))
  )
    throw new Error("publication_invalid_signature");
}
