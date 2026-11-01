import { DecisionAnalyticsError, MAX_BODY_BYTES, MAX_PRODUCERS, parseDecisionEnvelope, type DecisionEvent, type ProducerContext } from "../../shared/decisionAnalyticsV3.ts";
import { planEvent, sameEvent, type CommitPlan, type Episode } from "./decision-analytics-model.ts";

export type AnalyticsEnv = {
  DECISION_ANALYTICS_ENABLED?: string; DECISION_ANALYTICS_SCHEMA_VERSION?: string;
  DECISION_ANALYTICS_DAILY_WRITE_ATTEMPTS?: string; DECISION_ANALYTICS_PUBLICATION_CONTENT_HASH?: string;
  DECISION_ANALYTICS_MAX_MAINTENANCE_AGE_MS?: string; DECISION_ANALYTICS_MAX_OVERDUE_MS?: string;
  DECISION_ANALYTICS_MAX_BACKLOG_ROWS?: string;
  DECISION_ANALYTICS_PRODUCERS?: string;
  STATS_CAPABILITY_CUTOVER?: string;
  OUTCOME_FACTS_ENABLED?: string;
};
export type AnalyticsConfig = { dailyAttempts: number; contentHash: string | null; maxAge: number; maxOverdue: number; maxBacklog: number; producers: readonly ProducerContext[] };
export type CalculationAuthorization = { expiresAt: number };
export type MaintenanceHealth = { lastSuccess: number | null; oldestOverdue: number | null; backlog: number; capped: boolean };
export type AnalyticsStore = {
  deduped(id: string, now: number): Promise<boolean>;
  episode(id: string, now: number): Promise<Episode | null>;
  reserveBudget(now: number, limit: number): Promise<boolean>;
  health(now: number): Promise<MaintenanceHealth>;
  commit(plan: CommitPlan, nonce: string): Promise<boolean>;
};
export type HandlerPorts = {
  now(): number; nonce(): string;
  allowed(request: Request): boolean;
  readPayload(request: Request): Promise<unknown>;
  limit(request: Request): Promise<void>;
  verify(request: Request, token: string): Promise<void>;
  guard(): Promise<void>;
  authorizeCalculation?(request: Request, calculation: Extract<DecisionEvent, { stage: "calculation" }>["data"]): Promise<CalculationAuthorization>;
  store(): AnalyticsStore;
  respond(body: unknown, status: number): Response;
  expectedError?(error: unknown): { status: number; code: string; retryable: boolean } | null;
};

/** No defaults/derived releases. A configured version maps to exactly one immutable public hash. */
export function parseProducers(value: string | undefined): readonly ProducerContext[] | null {
  if (!value || value.length > 512) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_PRODUCERS) return null;
  const versions = new Set<string>();
  const result: ProducerContext[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).sort().join(",") !== "producerCodeHash,producerVersion" ||
        typeof item.producerVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item.producerVersion) ||
        typeof item.producerCodeHash !== "string" || !/^[0-9a-f]{64}$/.test(item.producerCodeHash) ||
        versions.has(item.producerVersion)) return null;
    versions.add(item.producerVersion);
    result.push(Object.freeze({ producerVersion: item.producerVersion, producerCodeHash: item.producerCodeHash }));
  }
  return Object.freeze(result);
}
export function producerAllowed(producer: ProducerContext, config: AnalyticsConfig): boolean {
  return config.producers.some((item) => item.producerVersion === producer.producerVersion &&
    item.producerCodeHash === producer.producerCodeHash);
}
export function analyticsConfig(env: AnalyticsEnv, authenticatedPublication = false): AnalyticsConfig | null {
  const integer = (value: string | undefined, minimum: number, maximum = Number.MAX_SAFE_INTEGER) => {
    if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= minimum && n <= maximum ? n : null;
  };
  const dailyAttempts = integer(env.DECISION_ANALYTICS_DAILY_WRITE_ATTEMPTS, 1);
  const maxAge = integer(env.DECISION_ANALYTICS_MAX_MAINTENANCE_AGE_MS, 1);
  const maxOverdue = integer(env.DECISION_ANALYTICS_MAX_OVERDUE_MS, 0);
  const maxBacklog = integer(env.DECISION_ANALYTICS_MAX_BACKLOG_ROWS, 0, 400);
  const contentHash = authenticatedPublication ? null : env.DECISION_ANALYTICS_PUBLICATION_CONTENT_HASH;
  const producers = parseProducers(env.DECISION_ANALYTICS_PRODUCERS);
  if (env.DECISION_ANALYTICS_SCHEMA_VERSION !== "3" || !producers || dailyAttempts === null ||
      maxAge === null || maxOverdue === null || maxBacklog === null ||
      (!authenticatedPublication && (!contentHash || !/^[0-9a-f]{64}$/.test(contentHash)))) return null;
  return { dailyAttempts, maxAge, maxOverdue, maxBacklog, contentHash: contentHash ?? null, producers };
}

export function assertMaintenance(health: MaintenanceHealth, config: AnalyticsConfig, now: number) {
  if (health.lastSuccess === null || !Number.isSafeInteger(health.lastSuccess) ||
      health.lastSuccess > now || now - health.lastSuccess > config.maxAge ||
      !Number.isSafeInteger(health.backlog) || health.backlog < 0 || health.capped ||
      (health.backlog === 0) !== (health.oldestOverdue === null) ||
      health.backlog > config.maxBacklog ||
      (health.oldestOverdue !== null && (!Number.isSafeInteger(health.oldestOverdue) ||
        health.oldestOverdue > now || now - health.oldestOverdue > config.maxOverdue))) {
    throw new DecisionAnalyticsError(503, "analytics_maintenance_unavailable");
  }
}

export async function handleDecisionAnalytics(request: Request, env: AnalyticsEnv, ports: HandlerPorts): Promise<Response> {
  const fail = (status: number, error: string, retryable = false) => ports.respond({ error, retryable }, status);
  // v3 writes preconfirmation episodes. They must not coexist with outcome-only admission.
  if (env.STATS_CAPABILITY_CUTOVER === "true" || env.OUTCOME_FACTS_ENABLED === "true")
    return fail(410, "decision_v3_retired");
  if (env.DECISION_ANALYTICS_ENABLED !== "true") return fail(404, "feature_unavailable");
  const config = analyticsConfig(env, Boolean(ports.authorizeCalculation));
  if (!config) return fail(503, "analytics_not_ready");
  try {
    if (request.method !== "POST") return fail(405, "method_not_allowed");
    if (!ports.allowed(request)) return fail(403, "origin_not_allowed");
    if (!(request.headers.get("Content-Type") || "").includes("application/json")) return fail(415, "json_required");
    const size = request.headers.get("Content-Length");
    if (size && (!/^[0-9]+$/.test(size) || Number(size) > MAX_BODY_BYTES)) return fail(413, "payload_too_large");
    await ports.limit(request);
    const { event, token } = parseDecisionEnvelope(await ports.readPayload(request));
    if (!ports.authorizeCalculation && event.stage === "calculation" && event.data.publicationContentHash !== config.contentHash)
      return fail(400, "unsupported_publication_content");
    if (event.stage === "calculation" && !producerAllowed(event.data, config))
      return fail(400, "unsupported_producer");
    await ports.verify(request, token);
    await ports.guard();
    const store = ports.store();
    const now = ports.now();
    const duplicate = await store.deduped(event.eventId, now);
    const episode = await store.episode(event.decisionId, now);
    if (episode && episode.expiresAt > now && !producerAllowed(episode.producer, config))
      return fail(409, "decision_producer_conflict");
    if (duplicate) {
      // Beyond the live linkage window this is deliberately opaque no-op dedupe.
      if (episode && episode.expiresAt > now &&
          !Object.values(episode.slots).some((slot: DecisionEvent) => sameEvent(slot, event)))
        return fail(409, "decision_event_conflict");
      return ports.respond({ ok: true, duplicate: true }, 200);
    }
    // Validate missing/expired/stage/ordinal conditions before spending admission-write budget.
    planEvent(episode, event, now);
    // Authentication of a new parent never reclassifies a pinned parent or a retry.
    const authorization = event.stage === "calculation" && ports.authorizeCalculation
      ? await ports.authorizeCalculation(request, event.data) : undefined;
    if (!(await store.reserveBudget(now, config.dailyAttempts))) return fail(429, "analytics_budget_exhausted");
    assertMaintenance(await store.health(ports.now()), config, ports.now());
    const commitNow = ports.now();
    if (ports.authorizeCalculation && event.stage === "calculation" &&
        (!authorization || !Number.isSafeInteger(authorization.expiresAt) || authorization.expiresAt <= commitNow))
      return fail(503, "analytics_not_ready");
    const plan = planEvent(episode, event, commitNow);
    if (!(await store.commit(plan, ports.nonce()))) return fail(503, "analytics_unavailable", true);
    return ports.respond({ ok: true, duplicate: false }, 200);
  } catch (error) {
    if (error instanceof DecisionAnalyticsError) return fail(error.status, error.message, error.retryable);
    const known = ports.expectedError?.(error);
    if (known) return fail(known.status, known.code, known.retryable);
    // Never serialize IDs, payloads, SQL/driver/provider text or arbitrary error messages.
    return fail(503, "analytics_unavailable", true);
  }
}
