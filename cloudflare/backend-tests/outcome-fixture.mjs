import registry from "../../shared/supplyForecasts.json" with { type: "json" };
import { assertCertifiedRuntimeSupplySnapshot } from "../../shared/certifiedSupply.ts";
import { buildV3SupplyForecastCandidate } from "../../shared/supplyForecastCandidate.ts";
import { encodeBase64, publicationHash, signPublication, ARTIFACT_DOMAIN, POINTER_DOMAIN } from "../../shared/forecastPublication.ts";
import { publicationWire } from "../../shared/forecast-publication/consumer-wire.ts";
import { normalizePublishedSupplyReference, selectPublishedSupplyReference } from "../../shared/decisionSupplyReference.ts";
import { prepareOutcomePublication } from "../src/outcome-public-store.ts";

export const NOW = Date.parse("2026-11-01T12:00:00Z");
export const PRODUCER = { producerVersion: "TEST-ONLY-outcome", producerCodeHash: "b".repeat(64) };
export const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
export const CONFIG = {
  OUTCOME_FACTS_ENABLED: "true", STATS_CAPABILITY_CUTOVER: "true", OUTCOME_FACTS_SCHEMA_VERSION: "4",
  DECISION_ANALYTICS_PRODUCERS: JSON.stringify([PRODUCER]), OUTCOME_FACTS_DAILY_WRITE_ATTEMPTS: "100",
  OUTCOME_FACTS_MAX_PUBLIC_ROWS: "1000", OUTCOME_FACTS_MAX_PUBLIC_BYTES: "1000000",
  OUTCOME_FACTS_MAX_MAINTENANCE_AGE_MS: "60000", OUTCOME_FACTS_MAX_OVERDUE_MS: "0", OUTCOME_FACTS_MAX_BACKLOG_ROWS: "0",
};
export async function publicFixture() {
  const entry = registry.forecasts.find(item => item.id === registry.approvedForecastId);
  const snapshot = assertCertifiedRuntimeSupplySnapshot(entry.certifiedSnapshot);
  const periods = snapshot.soloRounds.filter(round =>
    round.startGameDate > snapshot.coverage.currentDay && round.endGameDate).slice(0, 3).map(round => ({
    effectiveFrom: `${round.startGameDate}T05:00:00+09:00`,
    effectiveUntil: `${round.endGameDate}T05:00:00+09:00`, scheduleStatus: "estimated",
  }));
  const candidate = buildV3SupplyForecastCandidate({
    candidateId: "forecast-test-only-outcome", forecastId: entry.id, generatedAt: snapshot.asOf,
    sourceStatus: "x_unavailable", dispatchPolicyId: "dispatch-policy-v1",
    schedule: { status: "estimated", cadenceDays: null, soloStart: periods[0].effectiveFrom,
      soloEnd: periods[0].effectiveUntil, soloPeriods: periods, collaborationPeriods: [] },
    sourceEvidence: entry.sourceEvidence, warnings: [], certifiedSnapshot: snapshot,
  });
  const hash = await publicationHash(candidate);
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const trust = { environment: "production", keyId: "TEST-ONLY-key",
    publicKeyBase64: encodeBase64(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))) };
  const authorization = await signPublication({
    domain: ARTIFACT_DOMAIN, environment: trust.environment, keyId: trust.keyId,
    candidateId: candidate.candidateId, contentHash: hash,
  }, keys.privateKey);
  const pointer = await signPublication({
    domain: POINTER_DOMAIN, environment: trust.environment, keyId: trust.keyId, sequence: 1,
    mode: "active", candidateId: candidate.candidateId, contentHash: hash, operationId: "123", issuedAt: NOW,
  }, keys.privateKey);
  const wire = publicationWire({ pointer, artifact: { authorization, candidate } });
  const source = { publicationContentHash: hash, candidate };
  const reference = selectPublishedSupplyReference(source, Date.parse(snapshot.asOf));
  const normalized = normalizePublishedSupplyReference(source, reference);
  const publication = { contentHash: hash, wire, snapshot, signedCandidate: candidate };
  return { trust, publication, normalized, prepared: await prepareOutcomePublication(publication, normalized, {
    maxPublicRows: 1000, maxPublicBytes: 1_000_000,
  }) };
}
export function commit(publication, number = 1, data = {}) {
  return {
    version: 4, kind: "confirmed_outcome", operation: "commit", reportId: id(number),
    data: { ...PRODUCER, supplyReference: publication.normalized.reference,
      holdings: { blue: 40, purple: 20, yellow: 10 }, recommendedCurrent: "use_blue", chosenMethod: "use_blue",
      recommendedUses: 2, waitRecommended: true, outcome: "great", attemptCount: null, legacySettlement: null, ...data },
  };
}
export function legacy(outcome = "great_success", attempts = 1) {
  return {
    kind: "kit_result", start: { grade: "R", level: 0, exp: 0 }, kit: "blue", recommendedUses: 2,
    outcome, successAttempt: outcome === "great_success" ? attempts : null,
    stockBefore: { blue: 40, purple: 20, yellow: 10 },
    stockAfter: { blue: 40 - attempts * 10, purple: 20, yellow: 10 },
    resultState: outcome === "great_success" ? { grade: "R", level: 5, exp: 0 } : { grade: "R", level: 0, exp: 400 },
  };
}
export function patch(reportId, attemptCount, legacySettlement = null) {
  return { version: 4, kind: "confirmed_outcome", operation: "attempt_patch", reportId,
    data: { attemptCount, legacySettlement } };
}
