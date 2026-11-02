import {
  classifyOutcomeAttemptPatch, classifyOutcomeCommit, extractOutcomeRawFacts, outcomeCommitDigest,
  OUTCOME_MAX_BODY_BYTES, OutcomeAnalyticsError, parseOutcomeEnvelope, type OutcomeCommit,
} from "../../shared/decisionOutcomeV4.ts";
import { DecisionAnalyticsError } from "../../shared/decisionAnalyticsV3.ts";
import { assertMaintenance, parseProducers, type AnalyticsConfig } from "./decision-analytics-handler.ts";
import type { D1OutcomeStore } from "./outcome-store.ts";
import type { PreparedOutcomePublication } from "./outcome-public-store.ts";
import { legacySettlementDigest, validateOutcomeSettlement } from "./outcome-settlement.ts";

export type OutcomeEnv = {
  OUTCOME_FACTS_ENABLED?: string; STATS_CAPABILITY_CUTOVER?: string;
  OUTCOME_FACTS_SCHEMA_VERSION?: string; DECISION_ANALYTICS_PRODUCERS?: string;
  OUTCOME_FACTS_DAILY_WRITE_ATTEMPTS?: string;
  OUTCOME_FACTS_MAX_PUBLIC_ROWS?: string; OUTCOME_FACTS_MAX_PUBLIC_BYTES?: string;
  OUTCOME_FACTS_MAX_MAINTENANCE_AGE_MS?: string;
  OUTCOME_FACTS_MAX_OVERDUE_MS?: string; OUTCOME_FACTS_MAX_BACKLOG_ROWS?: string;
  OUTCOME_FACTS_MAINTENANCE_ENABLED?: string; OUTCOME_FACTS_MAINTENANCE_ROWS?: string;
};
export type OutcomeConfig = AnalyticsConfig & { maxPublicRows: number; maxPublicBytes: number };
export function configuredPositive(value: string | undefined, ceiling: number, minimum = 1): number | null {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= ceiling ? number : null;
}
export function outcomeConfig(env: OutcomeEnv): OutcomeConfig | null {
  const producers = parseProducers(env.DECISION_ANALYTICS_PRODUCERS);
  const dailyAttempts = configuredPositive(env.OUTCOME_FACTS_DAILY_WRITE_ATTEMPTS, Number.MAX_SAFE_INTEGER);
  // Technical work ceilings only. A deployment must supply reviewed smaller/equal budgets;
  // neither these bounds nor batch-count bounds establish CPU fit or an approved cost.
  const maxPublicRows = configuredPositive(env.OUTCOME_FACTS_MAX_PUBLIC_ROWS, 1000);
  const maxPublicBytes = configuredPositive(env.OUTCOME_FACTS_MAX_PUBLIC_BYTES, 1_000_000);
  const maxAge = configuredPositive(env.OUTCOME_FACTS_MAX_MAINTENANCE_AGE_MS, Number.MAX_SAFE_INTEGER);
  const maxOverdue = configuredPositive(env.OUTCOME_FACTS_MAX_OVERDUE_MS, Number.MAX_SAFE_INTEGER, 0);
  const maxBacklog = configuredPositive(env.OUTCOME_FACTS_MAX_BACKLOG_ROWS, 300, 0);
  if (env.OUTCOME_FACTS_SCHEMA_VERSION !== "4" || !producers || dailyAttempts === null ||
      maxPublicRows === null || maxPublicBytes === null || maxAge === null || maxOverdue === null || maxBacklog === null) return null;
  return { producers, dailyAttempts, contentHash: null, maxPublicRows, maxPublicBytes, maxAge, maxOverdue, maxBacklog };
}
export type OutcomePorts = {
  now(): number; nonce(): string;
  allowed(request: Request): boolean;
  readPayload(request: Request): Promise<unknown>;
  limit(request: Request): Promise<void>;
  verify(request: Request, token: string): Promise<void>;
  guard(): Promise<void>;
  store(): D1OutcomeStore;
  authorize(event: OutcomeCommit, config: OutcomeConfig): Promise<PreparedOutcomePublication>;
  respond(body: unknown, status: number): Response;
  expectedError?(error: unknown): { status: number; code: string; retryable: boolean } | null;
};

export async function handleOutcomeAnalytics(request: Request, env: OutcomeEnv, ports: OutcomePorts): Promise<Response> {
  const fail = (status: number, error: string, retryable = false) => ports.respond({ error, retryable }, status);
  if (env.OUTCOME_FACTS_ENABLED !== "true" || env.STATS_CAPABILITY_CUTOVER !== "true")
    return fail(404, "feature_unavailable");
  const config = outcomeConfig(env);
  if (!config) return fail(503, "outcome_not_ready");
  try {
    if (request.method !== "POST") return fail(405, "method_not_allowed");
    if (new URL(request.url).search) return fail(400, "unexpected_query");
    if (!ports.allowed(request)) return fail(403, "origin_not_allowed");
    if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json")
      return fail(415, "json_required");
    const size = request.headers.get("Content-Length");
    if (size && (!/^[0-9]+$/.test(size) || Number(size) > OUTCOME_MAX_BODY_BYTES))
      return fail(413, "payload_too_large");
    await ports.limit(request);
    const { event, token } = parseOutcomeEnvelope(await ports.readPayload(request));
    await ports.verify(request, token);
    await ports.guard();
    const store = ports.store(), now = ports.now();
    const previous = await store.lookup(event.reportId);
    if (previous && previous.rawAdmitted !== 1) return fail(503, "outcome_unavailable", true);
    if (event.operation === "commit") {
      const digest = await outcomeCommitDigest(event);
      const classification = classifyOutcomeCommit(previous?.initialCommitDigest ?? null, digest);
      if (classification === "conflict") return fail(409, "report_id_conflict");
      if (classification === "duplicate") return ports.respond({ ok: true, duplicate: true }, 200);
      if (!config.producers.some(producer => producer.producerVersion === event.data.producerVersion &&
          producer.producerCodeHash === event.data.producerCodeHash)) return fail(400, "unsupported_producer");
      const settlement = validateOutcomeSettlement(event.reportId, extractOutcomeRawFacts(event), event.data.legacySettlement);
      const settlementDigest = event.data.legacySettlement
        ? await legacySettlementDigest(event.reportId, event.data.legacySettlement) : null;
      if (!await store.reserveBudget(now, config.dailyAttempts)) return fail(429, "outcome_budget_exhausted");
      assertMaintenance(await store.health(now), config, now);
      const publication = await ports.authorize(event, config);
      if (await store.commit(event, digest, publication, ports.now(), ports.nonce(), settlement, settlementDigest))
        return ports.respond({ ok: true, duplicate: false }, 200);
      const concurrent = await store.lookup(event.reportId);
      if (!concurrent) return fail(503, "outcome_unavailable", true);
      return classifyOutcomeCommit(concurrent.initialCommitDigest, digest) === "duplicate"
        ? ports.respond({ ok: true, duplicate: true }, 200) : fail(409, "report_id_conflict");
    }
    if (!previous) return fail(404, "report_not_found");
    const control = await store.control(event.reportId);
    const { attemptCount, legacySettlement } = event.data;
    const classification = attemptCount === null ? "duplicate"
      : classifyOutcomeAttemptPatch(previous.facts.attemptCount, attemptCount,
          control !== null && control.expires_at > now, previous.facts.recommendedUses);
    if (classification === "conflict" || classification === "expired")
      return fail(409, classification === "conflict" ? "attempt_conflict" : "attempt_patch_expired");
    if (previous.facts.outcome === "no_great" && attemptCount !== null && attemptCount !== previous.facts.recommendedUses)
      return fail(400, "invalid_outcome_event");
    const settlement = validateOutcomeSettlement(event.reportId, previous.facts, legacySettlement,
      attemptCount ?? previous.facts.attemptCount);
    const settlementDigest = legacySettlement ? await legacySettlementDigest(event.reportId, legacySettlement) : null;
    if (previous.legacySettlementDigest !== null && settlementDigest !== null &&
        previous.legacySettlementDigest !== settlementDigest) return fail(409, "legacy_settlement_conflict");
    const applySettlement = settlement !== null && !previous.legacySettled;
    if (classification === "duplicate" && !applySettlement)
      return ports.respond({ ok: true, duplicate: true }, 200);
    if (!control || control.expires_at <= now) return fail(409, "attempt_patch_expired");
    if (classification === "apply" && control.legacy_attempt_count !== null &&
        attemptCount !== control.legacy_attempt_count) return fail(409, "attempt_conflict");
    if (!await store.reserveBudget(now, config.dailyAttempts)) return fail(429, "outcome_budget_exhausted");
    assertMaintenance(await store.health(now), config, now);
    if (await store.patch(event.reportId, attemptCount, previous, ports.now(), ports.nonce(), settlement, settlementDigest))
      return ports.respond({ ok: true, duplicate: false }, 200);
    const concurrent = await store.lookup(event.reportId);
    if (!concurrent) return fail(503, "outcome_unavailable", true);
    if (attemptCount !== null && concurrent.facts.attemptCount !== null && concurrent.facts.attemptCount !== attemptCount)
      return fail(409, "attempt_conflict");
    if (settlementDigest !== null && concurrent.legacySettlementDigest !== null &&
        concurrent.legacySettlementDigest !== settlementDigest) return fail(409, "legacy_settlement_conflict");
    if ((attemptCount === null || concurrent.facts.attemptCount === attemptCount) &&
        (settlementDigest === null || concurrent.legacySettlementDigest === settlementDigest))
      return ports.respond({ ok: true, duplicate: true }, 200);
    return fail(503, "outcome_concurrent_update", true);
  } catch (error) {
    if (error instanceof OutcomeAnalyticsError || error instanceof DecisionAnalyticsError)
      return fail(error.status, error.message, error.retryable);
    const expected = ports.expectedError?.(error);
    if (expected) return fail(expected.status, expected.code, expected.retryable);
    return fail(503, "outcome_unavailable", true);
  }
}
