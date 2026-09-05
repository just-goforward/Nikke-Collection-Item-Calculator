import { readBoundedJson } from "../../shared/boundedHttp";
import { ignoreExpectedError } from "./errorHandling";
import { StatsSubmissionError } from "./statsSubmissionQueue";

const STATS_ERROR_RESPONSE_MAX_BYTES = 16 * 1024;

function failureClass(status: number, message: string) {
  if (status === 429) return "rate_limited" as const;
  if (status >= 500) return "server_error" as const;
  if (message.includes("turnstile")) return "turnstile_rejected" as const;
  if (message.includes("origin")) return "origin_rejected" as const;
  if (status >= 400 && status < 500) return "contract_rejected" as const;
  return "unknown" as const;
}

export async function parseStatsSubmissionError(response: Response): Promise<StatsSubmissionError> {
  let message = response.statusText || "Statistics request failed.";
  let retryable = false;
  try {
    const body = (await readBoundedJson(
      response,
      STATS_ERROR_RESPONSE_MAX_BYTES,
      "stats_error_response_invalid",
    )) as { error?: unknown; retryable?: unknown };
    if (typeof body.error === "string") message = body.error;
    retryable = body.retryable === true;
  } catch (error) {
    ignoreExpectedError(
      "Malformed or oversized statistics error response; keep the response status text.",
      error,
    );
  }
  const retryableStatus = response.status === 429 || response.status >= 500;
  if (message === "telemetry_budget_disabled") {
    return new StatsSubmissionError(message, false, "quota_disabled");
  }
  if (!__STATS_DELIVERY_HEALTH_EMIT_ENABLED__) {
    return new StatsSubmissionError(message, retryable || retryableStatus);
  }
  return new StatsSubmissionError(
    message,
    retryable || retryableStatus,
    failureClass(response.status, message),
  );
}
