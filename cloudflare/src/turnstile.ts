import { HttpError } from "./http-error";
import { logWarn } from "./logger";

type TurnstileEventKind =
  | "kit_result"
  | "runtime_invariant"
  | "solver_diagnostic"
  | "solver_recovery";

type TurnstileEnv = {
  TURNSTILE_SECRET_KEY?: string;
};

type SiteverifyResult = {
  success?: boolean;
  action?: string;
  "error-codes"?: string[];
};

type SiteverifyTransportFailure = "fetch_error" | "http_status" | "invalid_json" | "timeout";

const TURNSTILE_VERIFY_TIMEOUT_MS = 5_000;
const TURNSTILE_CLIENT_RETRY_CODES = new Set(["timeout-or-duplicate", "invalid-input-response"]);

class SiteverifyTransportError extends Error {
  failure: SiteverifyTransportFailure;
  httpStatus: number | null;

  constructor(failure: SiteverifyTransportFailure, httpStatus: number | null = null) {
    super("Siteverify transport failed.");
    this.failure = failure;
    this.httpStatus = httpStatus;
  }
}

export async function verifyTurnstile(
  request: Request,
  env: TurnstileEnv,
  token: string,
  eventKind: TurnstileEventKind,
) {
  if (!env.TURNSTILE_SECRET_KEY) throw new HttpError(500, "turnstile_not_configured");
  if (typeof token !== "string" || token.length < 20 || token.length > 2048) {
    throw new HttpError(403, "turnstile_token_required", false);
  }

  const idempotencyKey = crypto.randomUUID();
  let internallyRetried = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result: SiteverifyResult;
    try {
      result = await requestTurnstileVerification(request, env, token, idempotencyKey);
    } catch (error) {
      if (attempt === 0) {
        internallyRetried = true;
        continue;
      }
      logTurnstileTransportFailure(eventKind, error, internallyRetried);
      throw new HttpError(502, "turnstile_unavailable", true);
    }

    if (result.success) {
      if (result.action && result.action !== eventKind) {
        logWarn("turnstile_action_mismatch", {
          eventKind,
          expectedAction: eventKind,
          returnedAction: result.action,
          internallyRetried,
        });
        throw new HttpError(403, "turnstile_action_mismatch", false);
      }
      return;
    }

    const errorCodes = Array.isArray(result["error-codes"]) ? result["error-codes"] : [];
    if (errorCodes.includes("internal-error") && attempt === 0) {
      internallyRetried = true;
      continue;
    }
    logTurnstileFailure(eventKind, result, internallyRetried);
    if (errorCodes.includes("internal-error")) {
      throw new HttpError(502, "turnstile_unavailable", true);
    }
    const retryable = errorCodes.some((code) => TURNSTILE_CLIENT_RETRY_CODES.has(code));
    throw new HttpError(403, "turnstile_failed", retryable);
  }
}

async function requestTurnstileVerification(
  request: Request,
  env: TurnstileEnv,
  token: string,
  idempotencyKey: string,
): Promise<SiteverifyResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURNSTILE_VERIFY_TIMEOUT_MS);
  try {
    const form = new URLSearchParams();
    form.append("secret", String(env.TURNSTILE_SECRET_KEY));
    form.append("response", token);
    form.append("idempotency_key", idempotencyKey);
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip) form.append("remoteip", ip);

    try {
      const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        signal: controller.signal,
      });
      let result: SiteverifyResult;
      try {
        result = (await response.json()) as SiteverifyResult;
      } catch (error) {
        throw invalidSiteverifyJson(error, response.status);
      }
      if (!response.ok && !Array.isArray(result["error-codes"])) {
        throw new SiteverifyTransportError("http_status", response.status);
      }
      return result;
    } catch (error) {
      if (error instanceof SiteverifyTransportError) throw error;
      throw new SiteverifyTransportError(controller.signal.aborted ? "timeout" : "fetch_error");
    }
  } finally {
    clearTimeout(timeout);
  }
}

function invalidSiteverifyJson(error: unknown, status: number): SiteverifyTransportError {
  void error;
  return new SiteverifyTransportError("invalid_json", status);
}

function logTurnstileFailure(
  eventKind: TurnstileEventKind,
  result: SiteverifyResult | null,
  internallyRetried: boolean,
) {
  logWarn("turnstile_verification_failed", {
    eventKind,
    expectedAction: eventKind,
    returnedAction: result?.action || null,
    errorCodes: result?.["error-codes"] || ["siteverify_unavailable"],
    internallyRetried,
  });
}

function logTurnstileTransportFailure(
  eventKind: TurnstileEventKind,
  error: unknown,
  internallyRetried: boolean,
) {
  const transportError = error instanceof SiteverifyTransportError ? error : null;
  logWarn("turnstile_verification_unavailable", {
    eventKind,
    expectedAction: eventKind,
    failure: transportError?.failure || "fetch_error",
    httpStatus: transportError?.httpStatus ?? null,
    internallyRetried,
  });
}
