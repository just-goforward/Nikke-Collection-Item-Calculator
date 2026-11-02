import { canonicalPublicSupply, type NormalizedPublicSupply } from "../../shared/decisionSupplyReference.ts";
import { canonicalPublicationJson, publicationHash } from "../../shared/forecastPublication.ts";
import { publicationBytesHash } from "../../shared/forecastPublicationBytes.ts";
import type { OutcomePublication } from "./outcome-publication.ts";
import { OutcomeAnalyticsError } from "../../shared/decisionOutcomeV4.ts";

export type OutcomeDatabase = Pick<D1DatabaseSession, "prepare" | "batch">;
export type PreparedOutcomePublication = {
  publication: OutcomePublication; normalized: NormalizedPublicSupply;
  slotId: string; normalizedDigest: string; lawsJson: string; releasesJson: string; linksJson: string;
};
export async function prepareOutcomePublication(
  publication: OutcomePublication, normalized: NormalizedPublicSupply,
  limits: { maxPublicRows: number; maxPublicBytes: number },
): Promise<PreparedOutcomePublication> {
  const laws = new Map<string, unknown>();
  const links: { eventId: string; lawId: string; count: number }[] = [];
  for (const release of normalized.releases) {
    for (const ref of release.laws) {
      laws.set(ref.lawId, publication.snapshot.laws.find(law => law.id === ref.lawId) ?? {
        id: ref.lawId, kind: ref.kind, modelVersion: ref.modelVersion,
      });
      links.push({ eventId: release.eventId, lawId: ref.lawId, count: ref.count });
    }
  }
  if (2 + normalized.releases.length + laws.size + links.length > limits.maxPublicRows)
    throw new OutcomeAnalyticsError(503, "publication_work_budget_exceeded");
  const lawsJson = canonicalPublicationJson([...laws.values()]);
  const releasesJson = canonicalPublicationJson(normalized.releases);
  const linksJson = canonicalPublicationJson(links);
  const canonical = canonicalPublicSupply(normalized);
  const bytes = [canonicalPublicationJson(publication.wire), canonical, lawsJson, releasesJson, linksJson]
    .reduce((total, value) => total + new TextEncoder().encode(value).byteLength, 0);
  if (bytes > limits.maxPublicBytes) throw new OutcomeAnalyticsError(503, "publication_work_budget_exceeded");
  return {
    publication, normalized, slotId: await publicationHash(normalized.reference),
    normalizedDigest: await publicationBytesHash(canonical), lawsJson, releasesJson, linksJson,
  };
}

export function outcomeArchiveStatements(
  db: OutcomeDatabase, prepared: PreparedOutcomePublication, reportId: string, nonce: string,
): D1PreparedStatement[] {
  const { publication, normalized: n, slotId, normalizedDigest, lawsJson, releasesJson, linksJson } = prepared;
  const { artifact, pointer } = publication.wire;
  const authorization = JSON.parse(artifact.authorization.statement) as { keyId: string; environment: string };
  const winner = `EXISTS(SELECT 1 FROM outcome_effects WHERE report_id=? AND initial_claim=? AND raw_admitted=0)`;
  const p = n.projection.status === "available" ? n.projection : null;
  const metadata = canonicalPublicationJson({
    candidateId: n.candidateId, forecastId: n.forecastId, rulesVersion: n.rulesVersion,
    snapshotVersion: n.snapshotVersion, futureLawSemantics: n.futureLawSemantics,
    dispatchPolicyId: n.dispatchPolicyId, sourceStatus: n.sourceStatus, snapshotSourceStatus: n.snapshotSourceStatus,
    coverage: n.coverage, uncertainty: n.uncertainty,
    populationPolicy: p?.populationPolicy ?? null, cohortWeights: p?.cohortWeights ?? null,
  });
  return [
    db.prepare(
      `INSERT INTO outcome_public_artifacts
       (content_hash,candidate_id,environment,key_id,pointer_statement,pointer_signature,
        authorization_statement,authorization_signature,candidate_json)
       SELECT ?,?,?,?,?,?,?,?,? WHERE ${winner} ON CONFLICT(content_hash) DO NOTHING`,
    ).bind(publication.contentHash, n.candidateId, authorization.environment, authorization.keyId,
      pointer.statement, pointer.signature, artifact.authorization.statement, artifact.authorization.signature,
      artifact.candidate, reportId, nonce),
    db.prepare(
      `INSERT INTO outcome_public_slots
       (slot_id,content_hash,normalized_digest,projection_policy,game_day,slot_start,slot_end,scope,
        projection_status,unavailable_reason,unit,blue_numerator,blue_denominator,purple_numerator,
        purple_denominator,yellow_numerator,yellow_denominator,metadata_json)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${winner} ON CONFLICT(slot_id) DO NOTHING`,
    ).bind(slotId, publication.contentHash, normalizedDigest, n.reference.projectionPolicyVersion,
      n.reference.gameDay, n.reference.slotStart, n.reference.slotEnd, n.scope, n.projection.status,
      n.projection.status === "unavailable" ? n.projection.reason : null, p?.unit ?? null,
      p?.expectedPieces.blue.numerator ?? null, p?.expectedPieces.blue.denominator ?? null,
      p?.expectedPieces.purple.numerator ?? null, p?.expectedPieces.purple.denominator ?? null,
      p?.expectedPieces.yellow.numerator ?? null, p?.expectedPieces.yellow.denominator ?? null,
      metadata, reportId, nonce),
    db.prepare(
      `INSERT INTO outcome_public_laws(content_hash,law_id,kind,model_version,law_json)
       SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.kind'),json_extract(value,'$.modelVersion'),value
       FROM json_each(?) WHERE ${winner} ON CONFLICT(content_hash,law_id) DO NOTHING`,
    ).bind(publication.contentHash, lawsJson, reportId, nonce),
    db.prepare(
      `INSERT INTO outcome_public_releases
       (slot_id,event_id,kind,schedule_status,available_at,expires_at,rule_id,cancelled,modeled,metadata_json)
       SELECT ?,json_extract(value,'$.eventId'),json_extract(value,'$.kind'),
         json_extract(value,'$.scheduleStatus'),json_extract(value,'$.availableAt'),
         json_extract(value,'$.expiresAt'),json_extract(value,'$.ruleId'),
         json_extract(value,'$.cancelled'),json_extract(value,'$.modeled'),
         json_remove(value,'$.laws')
       FROM json_each(?) WHERE ${winner} ON CONFLICT(slot_id,event_id) DO NOTHING`,
    ).bind(slotId, releasesJson, reportId, nonce),
    db.prepare(
      `INSERT INTO outcome_public_release_laws(slot_id,event_id,content_hash,law_id,count)
       SELECT ?,json_extract(value,'$.eventId'),?,json_extract(value,'$.lawId'),json_extract(value,'$.count')
       FROM json_each(?) WHERE ${winner} ON CONFLICT(slot_id,event_id,law_id) DO NOTHING`,
    ).bind(slotId, publication.contentHash, linksJson, reportId, nonce),
  ];
}
