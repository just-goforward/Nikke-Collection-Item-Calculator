import type { CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import { publicationWire } from "../../shared/forecast-publication/consumer-wire.ts";
import { ARTIFACT_DOMAIN, type PublicationEnvelope } from "../../shared/forecastPublication.ts";
import {
  verifyPublicationBytes, type PublicationBytes, type PublicationByteTrust,
} from "../../shared/forecastPublicationBytes.ts";
import { assertUsageAllowed } from "../../shared/usageGuard.ts";
import type { AnalyticsDatabase } from "./decision-analytics-store";
import { OutcomeAnalyticsError } from "../../shared/decisionOutcomeV4.ts";

export type OutcomePublicationTrust = Pick<PublicationByteTrust, "environment" | "keyId" | "publicKeyBase64">;
export type OutcomePublication = Readonly<{
  contentHash: string;
  wire: PublicationBytes & { artifact: NonNullable<PublicationBytes["artifact"]> };
  snapshot: CertifiedSupplySnapshot;
  signedCandidate: unknown;
}>;
type PublicationSource = {
  candidate_id: string; payload_hash: string; key_id: string; artifact_signature: string;
  payload_json: string; signed_pointer_json: string;
};

/** Resolve the reported approved publication, never the current active pointer.
 * The original Forecast DB remains authoritative; this reader performs no writes.
 * An authenticated Stats copy outlives calendar retention without pinning calendar data.
 */
export async function resolveOutcomePublication(
  contentHash: string,
  stats: AnalyticsDatabase,
  source: D1Database | undefined,
  guard: D1Database,
  trust: OutcomePublicationTrust,
  maxPublicBytes: number,
): Promise<OutcomePublication> {
  if (!/^[0-9a-f]{64}$/.test(contentHash)) throw new OutcomeAnalyticsError(400, "invalid_publication");
  const archived = await stats.prepare(
    `SELECT pointer_statement,pointer_signature,authorization_statement,authorization_signature,
     CASE WHEN length(CAST(candidate_json AS BLOB))<=? THEN candidate_json ELSE NULL END AS candidate_json
     FROM outcome_public_artifacts WHERE content_hash=?`,
  ).bind(maxPublicBytes, contentHash).first<{
    pointer_statement: string; pointer_signature: string; authorization_statement: string;
    authorization_signature: string; candidate_json: string | null;
  }>();
  let wire: PublicationBytes;
  if (archived) {
    if (archived.candidate_json === null) throw new OutcomeAnalyticsError(503, "publication_work_budget_exceeded");
    wire = {
      pointer: { statement: archived.pointer_statement, signature: archived.pointer_signature },
      artifact: {
        authorization: { statement: archived.authorization_statement, signature: archived.authorization_signature },
        candidate: archived.candidate_json,
      },
    };
  } else {
    if (!source) throw new OutcomeAnalyticsError(503, "publication_unavailable", true);
    await assertUsageAllowed(
      guard.withSession("first-primary"),
      trust.environment === "production" ? "production_forecast_automation" : "staging_automation",
      Date.now(),
    );
    // payload_hash is unique in versions; the remaining joins are primary-key lookups.
    // Only an approval's own activation is eligible, not an unsigned/sealed candidate.
    const row = await source.withSession("first-primary").prepare(
      `SELECT a.candidate_id,a.payload_hash,a.key_id,a.artifact_signature,
       CASE WHEN length(CAST(c.payload_json AS BLOB))<=? THEN c.payload_json ELSE NULL END AS payload_json,
       h.signed_pointer_json
       FROM forecast_runtime_versions v
       JOIN forecast_runtime_approvals a ON a.candidate_id=v.candidate_id AND a.payload_hash=v.payload_hash
       JOIN forecast_candidates c ON c.candidate_id=v.candidate_id
       JOIN forecast_runtime_activation_history h ON h.operation_id=a.interaction_id
       WHERE v.payload_hash=? AND a.environment=? AND h.environment=a.environment
       AND h.action='approve' AND h.candidate_id=a.candidate_id LIMIT 1`,
    ).bind(maxPublicBytes, contentHash, trust.environment).first<PublicationSource>();
    if (!row) throw new OutcomeAnalyticsError(409, "publication_not_approved");
    if (row.payload_json === null) throw new OutcomeAnalyticsError(503, "publication_work_budget_exceeded");
    wire = publicationWire({
      pointer: JSON.parse(row.signed_pointer_json) as PublicationEnvelope["pointer"],
      artifact: {
        authorization: {
          statement: {
            domain: ARTIFACT_DOMAIN, environment: trust.environment, keyId: row.key_id,
            candidateId: row.candidate_id, contentHash: row.payload_hash,
          },
          signature: row.artifact_signature,
        },
        candidate: JSON.parse(row.payload_json) as NonNullable<PublicationEnvelope["artifact"]>["candidate"],
      },
    });
  }
  // Historical references intentionally have no latest-sequence floor. Both signed
  // statements and the exact candidate digest are nevertheless authenticated every time.
  const verified = await verifyPublicationBytes(wire, { ...trust, minimumSequence: 0 });
  if (verified.pointer.contentHash !== contentHash || !verified.snapshot || !wire.artifact)
    throw new OutcomeAnalyticsError(409, "publication_mismatch");
  return {
    contentHash, wire: { ...wire, artifact: wire.artifact }, snapshot: verified.snapshot,
    signedCandidate: JSON.parse(wire.artifact.candidate) as unknown,
  };
}
