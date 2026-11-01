import {
  OUTCOME_TURNSTILE_ACTION, OutcomeAnalyticsError,
} from "../../shared/decisionOutcomeV4.ts";
import { normalizePublishedSupplyReference } from "../../shared/decisionSupplyReference.ts";
import type { SupplyForecastCandidate } from "../../shared/supplyForecastCandidate.ts";
import type { DecisionMetadataInstallation } from "./decision-analytics-publication.ts";
import type { WorkerEnv } from "./env.ts";
import { trustedClientIp } from "./client-ip.ts";
import { readJsonPayload } from "./event-submission.ts";
import { isAllowedOrigin, jsonResponse } from "./http.ts";
import { HttpError } from "./http-error.ts";
import { assertQuotaAllows } from "./quota-guard.ts";
import { verifyTurnstile } from "./turnstile.ts";
import { configuredPositive, handleOutcomeAnalytics } from "./outcome-handler.ts";
import { resolveOutcomePublication } from "./outcome-publication.ts";
import { prepareOutcomePublication } from "./outcome-public-store.ts";
import { D1OutcomeStore, OUTCOME_CLEANUP_MAX_ROWS } from "./outcome-store.ts";

export function handleOutcomeRequest(
  request: Request, env: WorkerEnv, installation?: Pick<DecisionMetadataInstallation, "trust">,
): Promise<Response> {
  let store: D1OutcomeStore | undefined;
  const storage = () => store ??= new D1OutcomeStore(env.DB.withSession("first-primary"));
  return handleOutcomeAnalytics(request, env, {
    now: Date.now, nonce: () => crypto.randomUUID(),
    allowed: req => isAllowedOrigin(req, env), readPayload: readJsonPayload,
    limit: async req => {
      if (!(await env.EVENT_RATE_LIMITER.limit({ key: trustedClientIp(req) })).success)
        throw new HttpError(429, "rate_limited", false);
    },
    verify: (req, token) => verifyTurnstile(req, env, token, OUTCOME_TURNSTILE_ACTION),
    guard: () => assertQuotaAllows(env, "statistics_write").then(() => undefined),
    store: storage,
    authorize: async (event, config) => {
      if (!installation || installation.trust.environment !== env.SITE_ENV)
        throw new OutcomeAnalyticsError(503, "outcome_not_ready");
      const publication = await resolveOutcomePublication(
        event.data.supplyReference.publicationContentHash, storage().db, env.FORECAST_DB,
        env.USAGE_GUARD_DB, installation.trust, config.maxPublicBytes,
      );
      const normalized = normalizePublishedSupplyReference({
        publicationContentHash: publication.contentHash,
        candidate: publication.signedCandidate as SupplyForecastCandidate,
      }, event.data.supplyReference);
      return prepareOutcomePublication(publication, normalized, config);
    },
    respond: (body, status) => jsonResponse(request, env, body, status),
    expectedError: error => error instanceof HttpError
      ? { status: error.status, code: error.message, retryable: error.retryable === true } : null,
  });
}

export async function handleOutcomeSummary(request: Request, env: WorkerEnv): Promise<Response> {
  if (new URL(request.url).search) throw new HttpError(400, "unexpected_query");
  if (!isAllowedOrigin(request, env)) throw new HttpError(403, "origin_not_allowed");
  if (!(await env.READ_RATE_LIMITER.limit({ key: trustedClientIp(request) })).success)
    throw new HttpError(429, "rate_limited", false);
  await assertQuotaAllows(env, "statistics_read");
  // This endpoint cannot read private facts or fall back when summaries are absent.
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(reports),0) reports,COALESCE(SUM(great_reports),0) great_reports,
     COALESCE(SUM(no_great_reports),0) no_great_reports,
     COALESCE(SUM(known_attempt_reports),0) known_attempt_reports,
     COALESCE(SUM(attempts),0) attempts,COALESCE(SUM(known_great_reports),0) known_great_reports
     FROM outcome_summary`,
  ).first<Record<string, number>>();
  if (!row) throw new OutcomeAnalyticsError(503, "outcome_summary_unavailable", true);
  return jsonResponse(request, env, {
    version: 4, reports: row["reports"],
    reportedOutcomes: { great: row["great_reports"], noGreat: row["no_great_reports"] },
    knownAttempts: { reports: row["known_attempt_reports"], attempts: row["attempts"],
      great: row["known_great_reports"], rate: row["attempts"]! > 0 ? row["known_great_reports"]! / row["attempts"]! : null },
  }, 200);
}

export async function cleanupOutcomeFacts(env: WorkerEnv, now: number): Promise<void> {
  if (env.OUTCOME_FACTS_MAINTENANCE_ENABLED !== "true" || env.OUTCOME_FACTS_SCHEMA_VERSION !== "4") return;
  const rows = configuredPositive(env.OUTCOME_FACTS_MAINTENANCE_ROWS, OUTCOME_CLEANUP_MAX_ROWS);
  if (rows === null) return;
  await assertQuotaAllows(env, "statistics_write");
  await new D1OutcomeStore(env.DB.withSession("first-primary")).cleanup(now, rows);
}
