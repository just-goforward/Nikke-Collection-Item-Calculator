import { buildCertifiedSupplySnapshot, type CertifiedSupplySnapshot } from "../shared/certifiedSupply";
import { forecastVersionsForSnapshot } from "../shared/certifiedVersionPolicy";
import {
  ARTIFACT_DOMAIN, POINTER_DOMAIN, publicationBytesHash, verifyPublicationBytes,
  type PublicationBytes, type PublicationEnvironment, type SignedPublicationBytes,
} from "../shared/forecastPublicationBytes";

/** Synthetic signed consumer fixtures shared by the two narrow regression tracks. */
export async function forecastAsyncFixtures(environment: PublicationEnvironment = "staging") {
  const asOf = "2026-09-30T04:00:00.000Z";
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const trust = {
    environment, keyId: "async-boundary-test",
    publicKeyBase64: Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64"),
  };
  const sign = async (value: object): Promise<SignedPublicationBytes> => {
    const statement = JSON.stringify(value);
    const signature = await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(statement));
    return { statement, signature: Buffer.from(signature).toString("base64") };
  };
  const publication = async (snapshot: CertifiedSupplySnapshot, sequence: number): Promise<PublicationBytes> => {
    const candidateId = "forecast-async-boundary-fixture";
    const candidate = JSON.stringify({ ...forecastVersionsForSnapshot(snapshot.version),
      candidateId, sourceStatus: "crosschecked", certifiedSnapshot: snapshot });
    const target = { environment: trust.environment, keyId: trust.keyId, candidateId,
      contentHash: await publicationBytesHash(candidate) };
    const value = {
      pointer: await sign({ ...target, domain: POINTER_DOMAIN, sequence, mode: "active",
        operationId: String(sequence), issuedAt: Date.parse(asOf) }),
      artifact: { authorization: await sign({ ...target, domain: ARTIFACT_DOMAIN }), candidate },
    };
    await verifyPublicationBytes(value, { ...trust, minimumSequence: 0 });
    return value;
  };
  const snapshot = buildCertifiedSupplySnapshot({
    asOf, revision: "async-source", sourceHash: "a".repeat(64),
    soloPeriods: [], collaborationPeriods: [],
  });
  const a = await publication(snapshot, 1);
  const b = await publication({ ...snapshot, rules: snapshot.rules.map((rule) => ({
    ...rule, normalShop: rule.normalShop.map((ref) => ({ ...ref, count: ref.count + 1 })),
  })) }, 2);
  const renewal = await publication(snapshot, 2);
  const rollback = await publication(snapshot, 4);
  const off = { pointer: await sign({ ...JSON.parse(a.pointer.statement),
    sequence: 3, operationId: "3", mode: "off", candidateId: null, contentHash: null }), artifact: null };
  const medianSnapshot = buildCertifiedSupplySnapshot({
    asOf: "2026-10-18T12:00:00+09:00", revision: "async-median", sourceHash: "b".repeat(64),
    cadenceVersion: "observed-median-v2", collaborationPeriods: [],
    soloPeriods: [
      { round: 41, effectiveFrom: "2026-09-24T12:00:00+09:00",
        effectiveUntil: "2026-10-01T04:59:59+09:00", scheduleStatus: "confirmed" },
      { round: 42, effectiveFrom: "2026-10-15T12:00:00+09:00",
        effectiveUntil: "2026-10-22T04:59:59+09:00", scheduleStatus: "confirmed" },
    ],
  });
  const median = await publication(medianSnapshot, 1);
  return { asOf, trust, a, b, renewal, rollback, off, median,
    medianStart: "2026-11-12T03:00:00.000Z" };
}
