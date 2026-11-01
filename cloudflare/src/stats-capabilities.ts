import { WorkerEntrypoint } from "cloudflare:workers";
import { OUTCOME_ANALYTICS_ENDPOINT, OutcomeAnalyticsError } from "../../shared/decisionOutcomeV4.ts";
import type { WorkerEnv } from "./env.ts";
import { handleEvent } from "./event-submission.ts";
import { decisionMetadataInstallation } from "./generated/decision-production-installation.ts";
import { handleOptions, jsonResponse } from "./http.ts";
import { HttpError } from "./http-error.ts";
import { handleOutcomeRequest, handleOutcomeSummary } from "./outcome-facts.ts";
import { queryCalculations, readCalculation } from "./outcome-raw-reader.ts";
import { handleSchemaHealth } from "./schema-health.ts";
import { readDiagnosticObservations } from "./stats-diagnostic-capability.ts";
import { handleCompactStats } from "./stats-read.ts";
import type {
  RawCalculationQuery, RawCalculationRequest, StatsDiagnostics, StatsIngest, StatsPublic, StatsRawReader,
} from "./stats-capability-contract.ts";

async function response(request: Request, env: WorkerEnv, operation: () => Promise<Response>): Promise<Response> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof HttpError || error instanceof OutcomeAnalyticsError)
      return jsonResponse(request, env, { error: error.message, retryable: error.retryable === true }, error.status);
    // Provider errors can contain SQL, private bindings or payloads. Do not log them.
    return jsonResponse(request, env, { error: "statistics_unavailable", retryable: true }, 503);
  }
}
async function rpc<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch { throw new Error("statistics_capability_unavailable"); }
}

export class Ingest extends WorkerEntrypoint<WorkerEnv> implements StatsIngest {
  async fetch(request: Request): Promise<Response> {
    return response(request, this.env, async () => {
      const url = new URL(request.url);
      if (url.search || (url.pathname !== OUTCOME_ANALYTICS_ENDPOINT && url.pathname !== "/api/events"))
        return jsonResponse(request, this.env, { error: "not_found" }, 404);
      if (request.method === "OPTIONS") return handleOptions(request, this.env);
      if (request.method !== "POST") return jsonResponse(request, this.env, { error: "method_not_allowed" }, 405);
      // Old kit_result clients remain a separate validated compatibility protocol.
      return url.pathname === "/api/events" ? handleEvent(request, this.env)
        : handleOutcomeRequest(request, this.env, decisionMetadataInstallation);
    });
  }
}
export class PublicStats extends WorkerEntrypoint<WorkerEnv> implements StatsPublic {
  async fetch(request: Request): Promise<Response> {
    return response(request, this.env, async () => {
      const url = new URL(request.url);
      if (url.search || !["/api/stats", "/api/health", "/api/outcome-summary"].includes(url.pathname))
        return jsonResponse(request, this.env, { error: "not_found" }, 404);
      if (request.method === "OPTIONS") return handleOptions(request, this.env);
      if (request.method !== "GET") return jsonResponse(request, this.env, { error: "method_not_allowed" }, 405);
      if (url.pathname === "/api/health") return handleSchemaHealth(request, this.env);
      return url.pathname === "/api/stats" ? handleCompactStats(request, this.env) : handleOutcomeSummary(request, this.env);
    });
  }
}
export class RawReader extends WorkerEntrypoint<WorkerEnv> implements StatsRawReader {
  readCalculation(input: RawCalculationRequest) { return rpc(() => readCalculation(this.env, input)); }
  queryCalculations(input: RawCalculationQuery) { return rpc(() => queryCalculations(this.env, input)); }
}
export class Diagnostics extends WorkerEntrypoint<WorkerEnv> implements StatsDiagnostics {
  readObservations(input: { cutoff: number }) {
    return rpc(() => readDiagnosticObservations(this.env, input?.cutoff));
  }
}
