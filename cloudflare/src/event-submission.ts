import {
  SOLVER_RECOVERY_APP_REVISION_PATTERN,
  SOLVER_RECOVERY_POLICY_VERSIONS,
  SOLVER_RECOVERY_SOLVER_VERSIONS,
  SOLVER_RECOVERY_VERSIONS,
} from "../../shared/solverRecoveryContract";
import type { WorkerEnv } from "./env";
import { commitSubmission, commitSubmissionRejection } from "./event-commit";
import { validatePayload } from "./event-validation";
import { isAllowedOrigin, jsonResponse } from "./http";
import { HttpError } from "./http-error";
import { assertQuotaAllows } from "./quota-guard";
import { EventSubmissionSchema } from "./schemas";
import { verifyTurnstile } from "./turnstile";

const MAX_BODY_BYTES = 4096;

export async function handleEvent(request: Request, env: WorkerEnv) {
  assertEventRequest(request, env);
  const now = Math.floor(Date.now() / 1000);
  await nativeRateLimit(request, env);

  const payload = await readJsonPayload(request);
  const parsedPayload = EventSubmissionSchema.safeParse(payload);
  if (!parsedPayload.success) {
    const envelope = securityEnvelope(payload);
    if (!envelope) throw new HttpError(400, "invalid_payload");
    await verifyTurnstile(request, env, envelope.turnstileToken, envelope.eventKind);
    await assertQuotaAllows(env, "statistics_write");
    const rejection = classifyRejectedPayload(envelope);
    await commitSubmissionRejection(env, rejection, now);
    throw new HttpError(400, rejection.rejectionCode);
  }

  await verifyTurnstile(
    request,
    env,
    parsedPayload.data.turnstileToken,
    parsedPayload.data.event.kind,
  );
  await assertQuotaAllows(env, "statistics_write");

  let normalized: ReturnType<typeof validatePayload>;
  try {
    normalized = validatePayload(parsedPayload.data);
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) {
      await commitSubmissionRejection(
        env,
        {
          appRevision: rejectedAppRevision(parsedPayload.data.event),
          eventId: parsedPayload.data.eventId,
          eventKind: parsedPayload.data.event.kind,
          policyVersion: rejectedPolicyVersion(parsedPayload.data.event),
          recoveryVersion: rejectedRecoveryVersion(parsedPayload.data.event),
          rejectionCode: rejectionCode(error.message),
        },
        now,
      );
    }
    throw error;
  }

  const duplicate = await commitSubmission(request, env, normalized, now);
  return jsonResponse(request, env, duplicate ? { ok: true, duplicate: true } : { ok: true });
}

type SecurityEnvelope = {
  event: Record<string, unknown>;
  eventId: string;
  eventKind: "kit_result" | "runtime_invariant" | "solver_diagnostic" | "solver_recovery";
  turnstileToken: string;
};

const EVENT_KINDS = new Set<SecurityEnvelope["eventKind"]>([
  "kit_result",
  "runtime_invariant",
  "solver_diagnostic",
  "solver_recovery",
]);

function securityEnvelope(payload: unknown): SecurityEnvelope | null {
  if (!isRecord(payload) || payload["version"] !== 1) return null;
  const eventId = payload["eventId"];
  const token = payload["turnstileToken"];
  const event = payload["event"];
  if (
    typeof eventId !== "string" ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(eventId) ||
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 2048 ||
    !isRecord(event) ||
    typeof event["kind"] !== "string" ||
    !EVENT_KINDS.has(event["kind"] as SecurityEnvelope["eventKind"])
  ) {
    return null;
  }
  return {
    event,
    eventId,
    eventKind: event["kind"] as SecurityEnvelope["eventKind"],
    turnstileToken: token,
  };
}

function classifyRejectedPayload(envelope: SecurityEnvelope) {
  const event = envelope.event;
  let code = "invalid_payload";
  if (envelope.eventKind === "solver_recovery") {
    if (!SOLVER_RECOVERY_VERSIONS.includes(event["recoveryVersion"] as never)) {
      code = "unsupported_recovery_version";
    } else if (!SOLVER_RECOVERY_POLICY_VERSIONS.includes(event["policyVersion"] as never)) {
      code = "unsupported_recovery_policy";
    } else if (event["recoveryVersion"] === 2 && !hasKnownSolverVersions(event["solverVersions"])) {
      code = "unsupported_solver_version";
    }
  }
  return {
    appRevision: rejectedAppRevision(event),
    eventId: envelope.eventId,
    eventKind: envelope.eventKind,
    policyVersion: rejectedPolicyVersion(event),
    recoveryVersion: rejectedRecoveryVersion(event),
    rejectionCode: code,
  };
}

function hasKnownSolverVersions(value: unknown) {
  return (
    isRecord(value) &&
    value["rustMinEf"] === SOLVER_RECOVERY_SOLVER_VERSIONS.rustMinEf &&
    value["rustPhase2"] === SOLVER_RECOVERY_SOLVER_VERSIONS.rustPhase2 &&
    value["jsPhase2"] === SOLVER_RECOVERY_SOLVER_VERSIONS.jsPhase2
  );
}

function rejectedRecoveryVersion(event: Record<string, unknown>) {
  return SOLVER_RECOVERY_VERSIONS.includes(event["recoveryVersion"] as never)
    ? String(event["recoveryVersion"])
    : "unsupported";
}

function rejectedPolicyVersion(event: Record<string, unknown>) {
  return SOLVER_RECOVERY_POLICY_VERSIONS.includes(event["policyVersion"] as never)
    ? String(event["policyVersion"])
    : "unsupported";
}

function rejectedAppRevision(event: Record<string, unknown>) {
  const value = event["appRevision"];
  return typeof value === "string" && SOLVER_RECOVERY_APP_REVISION_PATTERN.test(value)
    ? value
    : "unknown";
}

function rejectionCode(value: string) {
  return /^[a-z0-9_]{1,64}$/.test(value) ? value : "invalid_payload";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertEventRequest(request: Request, env: WorkerEnv) {
  if (!isAllowedOrigin(request, env)) throw new HttpError(403, "origin_not_allowed");
  if (!env.DB) throw new HttpError(500, "database_not_configured");
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) throw new HttpError(415, "json_required");
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large");
}

async function nativeRateLimit(request: Request, env: WorkerEnv) {
  const ip =
    request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  const result = await env.EVENT_RATE_LIMITER.limit({ key: ip });
  if (!result.success) throw new HttpError(429, "rate_limited", false);
}

export async function readJsonPayload(request: Request) {
  const stream = request.body;
  if (!stream) throw invalidJsonPayload(null);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_BODY_BYTES) {
        await reader.cancel("payload_too_large").catch(() => undefined);
        throw new HttpError(413, "payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw invalidJsonPayload(error);
  }
  return payload;
}

function invalidJsonPayload(error: unknown): HttpError {
  void error;
  return new HttpError(400, "invalid_json");
}
