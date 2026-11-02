import { MAX_STOCK_PIECES, type CollectionState, type Kit } from "./game.ts";
import { canonicalPublicationJson } from "./canonicalPublicationJson.ts";
import { publicationBytesHash } from "./publicationBytesHash.ts";
import { parsePublicSupplyReference, type PublicSupplyReference } from "./publicSupplyReference.ts";
export type { PublicSupplyReference } from "./publicSupplyReference.ts";

/** Separate protocol: existing M2/v3 pre-outcome/band semantics are not reinterpreted. */
export const OUTCOME_ANALYTICS_VERSION = 4 as const;
export const OUTCOME_ANALYTICS_KIND = "confirmed_outcome" as const;
export const OUTCOME_ANALYTICS_ENDPOINT = "/api/decision-outcomes";
export const OUTCOME_TURNSTILE_ACTION = "decision_outcome_v4";
export const OUTCOME_MAX_BODY_BYTES = 4096;
/** Existing kit_result wire bound (cloudflare/src/schemas.ts), not a new production threshold. */
export const OUTCOME_MAX_ATTEMPTS = 100;
/** One prepared run use consumes ten pieces, as in the existing outcome plans/validator. */
export const OUTCOME_PIECES_PER_USE = 10;
/** Technical proposal, not a measurement or a deployed retention guarantee. */
export const OUTCOME_ATTEMPT_PATCH_TTL_MS = 24 * 60 * 60 * 1000;
export const OUTCOME_RECEIPT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const OUTCOME_RETENTION = Object.freeze({
  rawFacts: "indefinite",
  reportUniqueness: "indefinite",
  initialCommitDigest: "immutable",
  operationalDeadlines: "bounded_private_store_only",
  legacySettlement: "transient_validation_and_once_only_settlement_not_raw_facts",
} as const);
export const OUTCOME_METHODS = ["use_blue", "use_purple", "use_yellow"] as const;
export type OutcomeMethod = (typeof OUTCOME_METHODS)[number];
export type OutcomeHoldings = { blue: number; purple: number; yellow: number };
export type ConfirmedOutcome = "great" | "no_great";
/** Exact makeStatsEvent payload; existing server kit_result validation remains mandatory.
 * No strategy, envelope metadata or automatic full-state capture is added.
 */
export type OutcomeLegacySettlement = {
  kind: "kit_result";
  start: CollectionState;
  kit: Kit;
  recommendedUses: number;
  outcome: "great_success" | "no_great_success";
  successAttempt: number | null;
  stockBefore: OutcomeHoldings;
  stockAfter: OutcomeHoldings;
  resultState: CollectionState;
};
export type OutcomeRawFacts = {
  producerVersion: string;
  producerCodeHash: string;
  supplyReference: PublicSupplyReference;
  holdings: OutcomeHoldings;
  recommendedCurrent: OutcomeMethod;
  chosenMethod: OutcomeMethod;
  /** Actual prepared.run.count for the accepted chosen method, not a probability or pieces. */
  recommendedUses: number;
  waitRecommended: boolean;
  outcome: ConfirmedOutcome;
  /** Explicit self-report only; null stays unknown even when stock correction yields a count. */
  attemptCount: number | null;
};
export type OutcomeCommit = {
  version: 4;
  kind: typeof OUTCOME_ANALYTICS_KIND;
  operation: "commit";
  /** UUIDv4 allocated once after confirmation, before the first POST; reused on retry. */
  reportId: string;
  data: OutcomeRawFacts & {
    /** Already produced by the accepted legacy UI path, or null if not yet eligible. */
    legacySettlement: OutcomeLegacySettlement | null;
  };
};
export type OutcomeAttemptPatch = {
  version: 4;
  kind: typeof OUTCOME_ANALYTICS_KIND;
  operation: "attempt_patch";
  reportId: string;
  data: {
    /** null permits settlement-only correction without inventing an explicit attempt report. */
    attemptCount: number | null;
    legacySettlement: OutcomeLegacySettlement | null;
  };
};
export type OutcomeEvent = OutcomeCommit | OutcomeAttemptPatch;
/** Every network attempt, including a duplicate or patch, needs a fresh verified token. */
export type OutcomeEnvelope = OutcomeEvent & { turnstileToken: string };
export type OutcomeResponse = { ok: true; duplicate: boolean } | { error: string; retryable: boolean };

export class OutcomeAnalyticsError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, code: string, retryable = false) {
    super(code); this.name = "OutcomeAnalyticsError"; this.status = status; this.retryable = retryable;
  }
}
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid(): never { throw new OutcomeAnalyticsError(400, "invalid_outcome_event"); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) invalid();
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid();
  return Object.is(value, -0) ? 0 : value as number;
}
function method(value: unknown): OutcomeMethod {
  if (typeof value !== "string" || !OUTCOME_METHODS.includes(value as OutcomeMethod)) invalid();
  return value as OutcomeMethod;
}
function holdings(value: unknown): OutcomeHoldings {
  exact(value, ["blue", "purple", "yellow"]);
  return {
    blue: integer(value["blue"], 0, MAX_STOCK_PIECES),
    purple: integer(value["purple"], 0, MAX_STOCK_PIECES),
    yellow: integer(value["yellow"], 0, MAX_STOCK_PIECES),
  };
}
function legacyState(value: unknown): CollectionState {
  exact(value, ["grade", "level", "exp"]);
  if (value["grade"] !== "R" && value["grade"] !== "SR") invalid();
  return { grade: value["grade"], level: integer(value["level"], 0, 15), exp: integer(value["exp"], 0, 2900) };
}
/** Shape/bounds only. Do not replace validateKitResultSubmission with this parser. */
function legacySettlement(value: unknown): OutcomeLegacySettlement | null {
  if (value === null) return null;
  exact(value, ["kind", "start", "kit", "recommendedUses", "outcome", "successAttempt", "stockBefore", "stockAfter", "resultState"]);
  if (value["kind"] !== "kit_result" || !["blue", "purple", "yellow"].includes(value["kit"] as string) ||
      (value["outcome"] !== "great_success" && value["outcome"] !== "no_great_success")) invalid();
  return {
    kind: "kit_result", start: legacyState(value["start"]), kit: value["kit"] as Kit,
    recommendedUses: integer(value["recommendedUses"], 1, OUTCOME_MAX_ATTEMPTS),
    outcome: value["outcome"],
    successAttempt: value["successAttempt"] === null ? null : integer(value["successAttempt"], 1, OUTCOME_MAX_ATTEMPTS),
    stockBefore: holdings(value["stockBefore"]), stockAfter: holdings(value["stockAfter"]),
    resultState: legacyState(value["resultState"]),
  };
}
/** Cross-protocol identity binding only; the existing server validator owns game transitions. */
export function assertOutcomeSettlementBinding(
  facts: OutcomeRawFacts, settlement: OutcomeLegacySettlement,
  explicitAttemptCount: number | null = facts.attemptCount,
): void {
  if (`use_${settlement.kit}` !== facts.chosenMethod ||
      settlement.recommendedUses !== facts.recommendedUses ||
      settlement.outcome !== (facts.outcome === "great" ? "great_success" : "no_great_success") ||
      (["blue", "purple", "yellow"] as const).some(color => settlement.stockBefore[color] !== facts.holdings[color]) ||
      (explicitAttemptCount !== null &&
        explicitAttemptCount !== (settlement.outcome === "great_success" ? settlement.successAttempt : settlement.recommendedUses)))
    throw new OutcomeAnalyticsError(400, "outcome_settlement_mismatch");
}
function normalizeEvent(value: unknown): OutcomeEvent {
  exact(value, ["version", "kind", "operation", "reportId", "data"]);
  if (value["version"] !== OUTCOME_ANALYTICS_VERSION || value["kind"] !== OUTCOME_ANALYTICS_KIND ||
      typeof value["reportId"] !== "string" || !UUID_V4.test(value["reportId"])) invalid();
  const common = { version: OUTCOME_ANALYTICS_VERSION, kind: OUTCOME_ANALYTICS_KIND, reportId: value["reportId"] };
  const data = value["data"];
  if (value["operation"] === "attempt_patch") {
    exact(data, ["attemptCount", "legacySettlement"]);
    const settlement = legacySettlement(data["legacySettlement"]);
    const attemptCount = data["attemptCount"] === null ? null : integer(data["attemptCount"], 1, OUTCOME_MAX_ATTEMPTS);
    if (attemptCount === null && settlement === null) invalid();
    if (settlement && attemptCount !== null &&
        attemptCount !== (settlement.outcome === "great_success" ? settlement.successAttempt : settlement.recommendedUses))
      throw new OutcomeAnalyticsError(400, "outcome_settlement_mismatch");
    return { ...common, operation: "attempt_patch", data: { attemptCount, legacySettlement: settlement } };
  }
  if (value["operation"] !== "commit") invalid();
  exact(data, ["producerVersion", "producerCodeHash", "supplyReference", "holdings",
    "recommendedCurrent", "chosenMethod", "recommendedUses", "waitRecommended", "outcome", "attemptCount", "legacySettlement"]);
  if (typeof data["producerVersion"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(data["producerVersion"]) ||
      typeof data["producerCodeHash"] !== "string" || !/^[a-f0-9]{64}$/.test(data["producerCodeHash"]) ||
      typeof data["waitRecommended"] !== "boolean" ||
      (data["outcome"] !== "great" && data["outcome"] !== "no_great")) invalid();
  const stock = holdings(data["holdings"]);
  const chosenMethod = method(data["chosenMethod"]);
  const chosenKit: Kit = chosenMethod === "use_blue" ? "blue" : chosenMethod === "use_purple" ? "purple" : "yellow";
  const recommendedUses = integer(data["recommendedUses"], 1, OUTCOME_MAX_ATTEMPTS);
  const attemptCount = data["attemptCount"] === null ? null : integer(data["attemptCount"], 1, recommendedUses);
  if (recommendedUses * OUTCOME_PIECES_PER_USE > stock[chosenKit] ||
      (data["outcome"] === "no_great" && attemptCount !== null && attemptCount !== recommendedUses)) invalid();
  let supplyReference: PublicSupplyReference;
  try { supplyReference = parsePublicSupplyReference(data["supplyReference"]); } catch { invalid(); }
  const event: OutcomeCommit = { ...common, operation: "commit", data: {
    producerVersion: data["producerVersion"], producerCodeHash: data["producerCodeHash"], supplyReference,
    holdings: stock,
    recommendedCurrent: method(data["recommendedCurrent"]), chosenMethod, recommendedUses,
    waitRecommended: data["waitRecommended"], outcome: data["outcome"],
    attemptCount, legacySettlement: legacySettlement(data["legacySettlement"]),
  } };
  if (event.data.legacySettlement) assertOutcomeSettlementBinding(event.data, event.data.legacySettlement);
  return event;
}
export function parseOutcomeEnvelope(value: unknown): { event: OutcomeEvent; token: string } {
  exact(value, ["version", "kind", "operation", "reportId", "data", "turnstileToken"]);
  const token = value["turnstileToken"];
  if (typeof token !== "string" || token.length < 20 || token.length > 2048)
    throw new OutcomeAnalyticsError(403, "turnstile_token_required");
  const event = normalizeEvent({
    version: value["version"], kind: value["kind"], operation: value["operation"],
    reportId: value["reportId"], data: value["data"],
  });
  if (new TextEncoder().encode(JSON.stringify({ ...event, turnstileToken: token })).byteLength > OUTCOME_MAX_BODY_BYTES)
    throw new OutcomeAnalyticsError(413, "outcome_body_too_large");
  return { event, token };
}

/** Digest the ORIGINAL normalized commit, not a row mutated by a later attempt patch. */
export function canonicalOutcomeCommit(value: OutcomeCommit): string {
  const event = normalizeEvent(value);
  if (event.operation !== "commit") invalid();
  return canonicalPublicationJson(event);
}
export function outcomeCommitDigest(value: OutcomeCommit): Promise<string> {
  return publicationBytesHash(canonicalOutcomeCommit(value));
}
export function canonicalOutcomeAttemptPatch(value: OutcomeAttemptPatch): string {
  const event = normalizeEvent(value);
  if (event.operation !== "attempt_patch") invalid();
  return canonicalPublicationJson(event);
}
export function outcomeAttemptPatchDigest(value: OutcomeAttemptPatch): Promise<string> {
  return publicationBytesHash(canonicalOutcomeAttemptPatch(value));
}
/** Permanent raw storage allowlist, insufficient to rebuild historical legacy groups.
 * Never persist canonical transport JSON as raw facts.
 */
export function extractOutcomeRawFacts(value: OutcomeCommit): OutcomeRawFacts {
  const event = normalizeEvent(value);
  if (event.operation !== "commit") invalid();
  const data = event.data;
  return {
    producerVersion: data.producerVersion, producerCodeHash: data.producerCodeHash,
    supplyReference: data.supplyReference, holdings: data.holdings,
    recommendedCurrent: data.recommendedCurrent, chosenMethod: data.chosenMethod,
    recommendedUses: data.recommendedUses, waitRecommended: data.waitRecommended,
    outcome: data.outcome, attemptCount: data.attemptCount,
  };
}
/** Permanent uniqueness lookup precedes receipt expiry and attempt-patch state. */
export function classifyOutcomeCommit(storedInitialDigest: string | null, incomingDigest: string): "insert" | "duplicate" | "conflict" {
  if (storedInitialDigest === null) return "insert";
  return storedInitialDigest === incomingDigest ? "duplicate" : "conflict";
}
/** Call only for an explicit positive count, using the stored prepared quantity.
 * Settlement-only patches (null count) must not alter or infer raw attemptCount.
 * Expiry only closes a NULL→positive transition; repeated accepted values remain no-ops.
 */
export function classifyOutcomeAttemptPatch(
  stored: number | null, requested: number, patchWindowOpen: boolean, recommendedUses: number,
): "apply" | "duplicate" | "conflict" | "expired" {
  integer(recommendedUses, 1, OUTCOME_MAX_ATTEMPTS);
  integer(requested, 1, recommendedUses);
  if (stored !== null) {
    integer(stored, 1, recommendedUses);
    return stored === requested ? "duplicate" : "conflict";
  }
  return patchWindowOpen ? "apply" : "expired";
}
