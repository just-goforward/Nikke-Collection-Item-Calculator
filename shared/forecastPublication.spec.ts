import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalPublicationJson,
  encodeBase64,
  importPublicationSigningKey,
  POINTER_DOMAIN,
  type PointerStatement,
  publicationHash,
  signPublication,
  verifyPublication,
} from "./forecastPublication.ts";

describe("publication canonical signature contract", () => {
  it("uses deterministic code-unit ordering and UTF-8 hashing independent of object insertion order", async () => {
    const value = { z: [null, true, "한글"], a: 1, A: 2 };
    const expected = '{"A":2,"a":1,"z":[null,true,"한글"]}';
    expect(canonicalPublicationJson(value)).toBe(expected);
    expect(await publicationHash(value)).toBe(
      createHash("sha256").update(expected, "utf8").digest("hex"),
    );
    expect(() => canonicalPublicationJson({ value: undefined })).toThrow();
    expect(() => canonicalPublicationJson(Number.NaN)).toThrow();
    expect(() => canonicalPublicationJson(new Array(2))).toThrow();
  });
  it("signs off monotonically and rejects tamper, wrong key, environment and stale sequence", async () => {
    const key = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const imported = await importPublicationSigningKey(
      encodeBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey))),
    );
    const statement: PointerStatement = {
      domain: POINTER_DOMAIN,
      environment: "staging",
      keyId: "test",
      sequence: 9,
      mode: "off",
      candidateId: null,
      contentHash: null,
      operationId: "12345",
      issuedAt: 1788231600000,
    };
    const envelope = { pointer: await signPublication(statement, imported), artifact: null };
    const trust = {
      environment: "staging" as const,
      keyId: "test",
      publicKeyBase64: encodeBase64(
        new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey)),
      ),
      minimumSequence: 9,
    };
    await expect(verifyPublication(envelope, trust)).resolves.toEqual(envelope);
    await expect(verifyPublication(envelope, { ...trust, minimumSequence: 10 })).rejects.toThrow();
    await expect(
      verifyPublication(envelope, { ...trust, environment: "production" }),
    ).rejects.toThrow();
    await expect(verifyPublication(envelope, { ...trust, keyId: "wrong" })).rejects.toThrow();
    const wrongKey = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    await expect(
      verifyPublication(envelope, {
        ...trust,
        publicKeyBase64: encodeBase64(
          new Uint8Array(await crypto.subtle.exportKey("raw", wrongKey.publicKey)),
        ),
      }),
    ).rejects.toThrow();
    const tampered = structuredClone(envelope);
    tampered.pointer.statement.sequence = 10;
    await expect(verifyPublication(tampered, trust)).rejects.toThrow();
    const malformed = {
      pointer: await signPublication({ ...statement, candidateId: "forecast-invalid" }, imported),
      artifact: null,
    };
    await expect(verifyPublication(malformed, trust)).rejects.toThrow();
  });
});
