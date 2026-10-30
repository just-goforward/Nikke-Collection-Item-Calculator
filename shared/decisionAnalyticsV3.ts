/** Anonymous per-accepted-result observations, not gameplay or numerical runtime inputs. */
export const DECISION_ANALYTICS_KIND = "decision_episode" as const;
export const DECISION_ANALYTICS_ENDPOINT = "/api/decision-events";
export const DECISION_ANALYTICS_VERSION = 3 as const;
export const EPISODE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEDUPE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const AGGREGATE_DAYS = 90;
export const MAX_BODY_BYTES = 4096;
export const MAX_STATE_BYTES = 8192;
export const MAX_PRODUCERS = 2;
export const MAX_DAILY_CELLS_PER_PRODUCER = 139;
/** Per fixed configuration only; rotations can create additional persisted cohorts. */
export const MAX_DAILY_CELLS = MAX_PRODUCERS * MAX_DAILY_CELLS_PER_PRODUCER;
export const MAX_CONTRIBUTIONS = 24;
export const MAX_BATCH_STATEMENTS = MAX_CONTRIBUTIONS + 3;
export const MEMORY_RETRY = Object.freeze({ maxEvents: 20, ttlMs: 15 * 60 * 1000, maxAttempts: 3 });
export const STAGES = ["calculation", "current_presented", "wait_presented", "first_action", "outcome_confirmation", "attempt_self_report", "terminal"] as const;
export const BANDS = ["zero", "one_to_nine", "ten_to_forty_nine", "fifty_to_one_ninety_nine", "two_hundred_plus"] as const;
export const CURRENT_ACTIONS = ["use_blue", "use_purple", "use_yellow", "preserve", "none"] as const;
export const ACTIONS = ["input_edit", "recalculate", "outcome_open", "outcome_confirm", "reset", "dismiss"] as const;
export const OUTCOMES = ["success", "fail"] as const;
export const ATTEMPTS = ["one", "two_to_four", "five_to_nine", "ten_plus"] as const;
export const TERMINALS = ["unknown", "input_edit", "new_solve", "reset", "restore", "forecast_invalid", "unmount", "cancelled", "superseded"] as const;
export type Stage = (typeof STAGES)[number];
export type Band = (typeof BANDS)[number];
export type Bands = { blue: Band; purple: Band; yellow: Band };
export type ProducerContext = Readonly<{ producerVersion: string; producerCodeHash: string }>;
export type StageData = {
  calculation: ProducerContext & {
    publicationContentHash: string; currentAction: (typeof CURRENT_ACTIONS)[number];
    waitRecommended: boolean; holdings: Bands; expectedSupply: Bands;
  };
  current_presented: Record<string, never>;
  wait_presented: Record<string, never>;
  first_action: { action: (typeof ACTIONS)[number] };
  outcome_confirmation: { outcome: (typeof OUTCOMES)[number] };
  attempt_self_report: { attempts: (typeof ATTEMPTS)[number]; outcomeEventId: string };
  terminal: { reason: (typeof TERMINALS)[number] };
};
export type DecisionEvent = {
  [K in Stage]: {
    version: 3; kind: typeof DECISION_ANALYTICS_KIND; eventId: string; decisionId: string;
    ordinal: number; stage: K; data: StageData[K];
  };
}[Stage];
export type DecisionEnvelope = DecisionEvent & { turnstileToken: string };
export type DecisionResponse = { ok: true; duplicate: boolean } | { error: string; retryable: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class DecisionAnalyticsError extends Error {
  status: number; retryable: boolean;
  constructor(status: number, code: string, retryable = false) {
    super(code); this.name = "DecisionAnalyticsError"; this.status = status; this.retryable = retryable;
  }
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key)))
    throw new DecisionAnalyticsError(400, "invalid_decision_event");
}
function member<T extends string>(value: unknown, values: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new DecisionAnalyticsError(400, "invalid_decision_event");
}
function bands(value: unknown): asserts value is Bands {
  exact(value, ["blue", "purple", "yellow"]);
  for (const color of ["blue", "purple", "yellow"]) member(value[color], BANDS);
}
export function parseDecisionEnvelope(value: unknown): { event: DecisionEvent; token: string } {
  exact(value, ["version", "kind", "eventId", "decisionId", "ordinal", "stage", "data", "turnstileToken"]);
  if (value["version"] !== 3 || value["kind"] !== DECISION_ANALYTICS_KIND ||
      typeof value["eventId"] !== "string" || !UUID.test(value["eventId"]) ||
      typeof value["decisionId"] !== "string" || !UUID.test(value["decisionId"]) || value["eventId"] === value["decisionId"] ||
      !Number.isSafeInteger(value["ordinal"]) || (value["ordinal"] as number) < 1 || (value["ordinal"] as number) > STAGES.length)
    throw new DecisionAnalyticsError(400, "invalid_decision_event");
  if (typeof value["turnstileToken"] !== "string" || value["turnstileToken"].length < 20 || value["turnstileToken"].length > 2048)
    throw new DecisionAnalyticsError(403, "turnstile_token_required");
  member(value["stage"], STAGES);
  const data = value["data"];
  switch (value["stage"]) {
    case "calculation":
      exact(data, ["producerVersion", "producerCodeHash", "publicationContentHash", "currentAction", "waitRecommended", "holdings", "expectedSupply"]);
      if (value["ordinal"] !== 1 || typeof data["publicationContentHash"] !== "string" ||
          !/^[0-9a-f]{64}$/.test(data["publicationContentHash"]) ||
          typeof data["producerVersion"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(data["producerVersion"]) ||
          typeof data["producerCodeHash"] !== "string" || !/^[0-9a-f]{64}$/.test(data["producerCodeHash"]) ||
          typeof data["waitRecommended"] !== "boolean") throw new DecisionAnalyticsError(400, "invalid_decision_event");
      member(data["currentAction"], CURRENT_ACTIONS); bands(data["holdings"]); bands(data["expectedSupply"]);
      break;
    case "first_action": exact(data, ["action"]); member(data["action"], ACTIONS); break;
    case "outcome_confirmation": exact(data, ["outcome"]); member(data["outcome"], OUTCOMES); break;
    case "attempt_self_report":
      exact(data, ["attempts", "outcomeEventId"]); member(data["attempts"], ATTEMPTS);
      if (typeof data["outcomeEventId"] !== "string" || !UUID.test(data["outcomeEventId"]) ||
          data["outcomeEventId"] === value["eventId"] || data["outcomeEventId"] === value["decisionId"])
        throw new DecisionAnalyticsError(400, "invalid_decision_event");
      break;
    case "terminal": exact(data, ["reason"]); member(data["reason"], TERMINALS); break;
    default: exact(data, []);
  }
  if (value["stage"] !== "calculation" && value["ordinal"] === 1)
    throw new DecisionAnalyticsError(400, "invalid_decision_event");
  return { event: {
    version: 3, kind: DECISION_ANALYTICS_KIND, eventId: value["eventId"], decisionId: value["decisionId"],
    ordinal: value["ordinal"] as number, stage: value["stage"], data,
  } as DecisionEvent, token: value["turnstileToken"] };
}
export function canonicalDecisionEvent(event: DecisionEvent): string {
  const sorted = (value: unknown): unknown => {
    if (value && typeof value === "object" && !Array.isArray(value))
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)]));
    return value;
  };
  return JSON.stringify(sorted(event));
}
