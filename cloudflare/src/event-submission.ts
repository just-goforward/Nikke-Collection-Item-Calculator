import type { WorkerEnv } from "./env";
import { commitSubmission } from "./event-commit";
import { validatePayload } from "./event-validation";
import { isAllowedOrigin, jsonResponse } from "./http";
import { HttpError } from "./http-error";
import { rateLimit } from "./rate-limit";
import { EventSubmissionSchema } from "./schemas";
import { verifyTurnstile } from "./turnstile";

const MAX_BODY_BYTES = 4096;
const PRE_MINUTE_LIMIT = 120;
const PRE_DAY_LIMIT = 1000;
const POST_MINUTE_LIMIT = 30;
const POST_DAY_LIMIT = 200;

export async function handleEvent(request: Request, env: WorkerEnv) {
  assertEventRequest(request, env);
  const now = Math.floor(Date.now() / 1000);
  await rateLimit(request, env, "pre", PRE_MINUTE_LIMIT, PRE_DAY_LIMIT, now);

  const payload = await readJsonPayload(request);
  const parsedPayload = EventSubmissionSchema.safeParse(payload);
  if (!parsedPayload.success) throw new HttpError(400, "invalid_payload");

  await verifyTurnstile(
    request,
    env,
    parsedPayload.data.turnstileToken,
    parsedPayload.data.event.kind,
  );
  await rateLimit(request, env, "post", POST_MINUTE_LIMIT, POST_DAY_LIMIT, now);

  const duplicate = await commitSubmission(request, env, validatePayload(parsedPayload.data), now);
  return jsonResponse(request, env, duplicate ? { ok: true, duplicate: true } : { ok: true });
}

function assertEventRequest(request: Request, env: WorkerEnv) {
  if (!isAllowedOrigin(request, env)) throw new HttpError(403, "origin_not_allowed");
  if (!env.DB) throw new HttpError(500, "database_not_configured");
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) throw new HttpError(415, "json_required");
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large");
  if (!env.RATE_LIMIT_SECRET) throw new HttpError(500, "rate_limit_not_configured");
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
