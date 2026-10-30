import {
  DECISION_ANALYTICS_ENDPOINT, DECISION_ANALYTICS_KIND, MAX_BODY_BYTES, parseDecisionEnvelope,
} from "../../shared/decisionAnalyticsV3.ts";
import type { DecisionEvent, DecisionResponse } from "../../shared/decisionAnalyticsV3.ts";

type Options = {
  enabled?: boolean;
  providerReady?: () => boolean;
  origin: string;
  token: (action: string, signal: AbortSignal) => Promise<string>;
  fetch: (url: string, init: RequestInit) => Promise<Pick<Response, "status" | "json">>;
};

/** A separate transport: no legacy envelope, sourceHost, persistent queue or credentials. */
export function createDecisionTransport(options: Options) {
  return async (event: DecisionEvent, signal: AbortSignal): Promise<DecisionResponse> => {
    if (options.enabled !== true) return { error: "feature_unavailable", retryable: false };
    try {
      if (options.providerReady?.() !== true) return { error: "feature_unavailable", retryable: false };
    } catch {
      return { error: "feature_unavailable", retryable: false };
    }
    if (!["https://nikkecollection.com", "https://staging.nikkecollection.com"].includes(options.origin))
      return { error: "feature_unavailable", retryable: false };
    if (signal.aborted) return { error: "analytics_unavailable", retryable: false };
    try {
      const turnstileToken = await options.token(DECISION_ANALYTICS_KIND, signal);
      if (signal.aborted || options.providerReady?.() !== true)
        return { error: "analytics_unavailable", retryable: false };
      const { event: validated, token } = parseDecisionEnvelope({ ...event, turnstileToken });
      const body = JSON.stringify({ ...validated, turnstileToken: token });
      if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES)
        return { error: "invalid_decision_event", retryable: false };
      const response = await options.fetch(options.origin + DECISION_ANALYTICS_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
        credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
        redirect: "error", signal,
      });
      const value = await response.json();
      if (value && typeof value === "object" && value.ok === true && typeof value.duplicate === "boolean" &&
          response.status >= 200 && response.status < 300)
        return { ok: true, duplicate: value.duplicate };
      if (value && typeof value === "object" && typeof value.error === "string" && typeof value.retryable === "boolean")
        return {
          error: value.error,
          retryable: !signal.aborted && value.retryable &&
            response.status !== 404 && response.status !== 410 &&
            value.error !== "analytics_maintenance_unavailable",
        };
      return { error: "analytics_unavailable", retryable: false };
    } catch {
      return { error: "analytics_unavailable", retryable: !signal.aborted };
    }
  };
}
