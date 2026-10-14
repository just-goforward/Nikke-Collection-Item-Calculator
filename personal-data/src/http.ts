import type { StageSummary, WorkspacePut } from "./contracts";

export const MAX_BODY_BYTES = 2_000_000;
export type Reason =
  | "invalid_request"
  | "request_too_large"
  | "origin_rejected"
  | "unauthenticated"
  | "auth_failed"
  | "rate_limited"
  | "beta_full"
  | "op_id_conflict"
  | "revision_conflict"
  | "service_unavailable"
  | "not_found"
  | "method_not_allowed"
  | "google_issuer_unsupported"
  | "account_switch_requires_logout"
  | "account_context_required"
  | "account_context_stale"
  | "consent_change_pending";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: Reason,
  ) {
    super(reason);
  }
}

/** Displayed-account precondition only: ownership still comes exclusively from the session. */
export function requireAccountContext(request: Request, userId: string): void {
  const context = request.headers.get("If-Account-Match");
  if (context === null) throw new HttpError(428, "account_context_required");
  if (context !== `"${userId}"`) throw new HttpError(409, "account_context_stale");
}

export function response(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(body, { status, headers });
}

export function sameOrigin(request: Request, origin: string): void {
  if (
    request.headers.get("Origin") !== origin ||
    ![null, "same-origin"].includes(request.headers.get("Sec-Fetch-Site"))
  ) {
    throw new HttpError(403, "origin_rejected");
  }
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  if (
    !request.headers
      .get("Content-Type")
      ?.split(";")[0]
      ?.trim()
      .match(/^application\/json$/i)
  ) {
    throw new HttpError(400, "invalid_request");
  }
  const length = request.headers.get("Content-Length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new HttpError(413, "request_too_large");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_request");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "request_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    if (!isObject(value)) throw new HttpError(400, "invalid_request");
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_request");
  } finally {
    reader.releaseLock();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new HttpError(400, "invalid_request");
  }
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
export function opBody(value: Record<string, unknown>): string {
  exactKeys(value, ["opId"]);
  if (!validId(value["opId"])) throw new HttpError(400, "invalid_request");
  return value["opId"];
}
function stage(value: unknown): value is StageSummary {
  if (!isObject(value)) return false;
  exactKeys(value, [
    "itemId",
    "stage",
    "lifetimeAttempts",
    "lifetimeIncome",
    "preSignupIncome",
    "manualEntry",
    "verified",
  ]);
  const income = value["lifetimeIncome"];
  const previous = value["preSignupIncome"];
  return (
    validId(value["itemId"]) &&
    validId(value["stage"]) &&
    Number.isSafeInteger(value["lifetimeAttempts"]) &&
    Number(value["lifetimeAttempts"]) >= 0 &&
    typeof income === "number" &&
    Number.isFinite(income) &&
    income >= 0 &&
    typeof previous === "number" &&
    Number.isFinite(previous) &&
    previous >= 0 &&
    previous <= income &&
    typeof value["manualEntry"] === "boolean" &&
    typeof value["verified"] === "boolean"
  );
}
function boundedJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => boundedJson(entry, depth + 1));
  return isObject(value) && Object.values(value).every((entry) => boundedJson(entry, depth + 1));
}
export function workspaceBody(value: Record<string, unknown>): WorkspacePut {
  exactKeys(value, ["opId", "baseRevision", "document", "action"]);
  const document = value["document"];
  const action = value["action"];
  if (
    !validId(value["opId"]) ||
    !Number.isSafeInteger(value["baseRevision"]) ||
    Number(value["baseRevision"]) < 0 ||
    !isObject(document) ||
    !isObject(action)
  ) {
    throw new HttpError(400, "invalid_request");
  }
  exactKeys(document, ["schemaVersion", "items", "lifetimeStages"]);
  if (
    document["schemaVersion"] !== 1 ||
    !Array.isArray(document["items"]) ||
    !boundedJson(document["items"]) ||
    !Array.isArray(document["lifetimeStages"]) ||
    !document["lifetimeStages"].every(stage)
  )
    throw new HttpError(400, "invalid_request");
  const stages = document["lifetimeStages"] as StageSummary[];
  if (
    new Set(stages.map((entry) => JSON.stringify([entry.itemId, entry.stage]))).size !==
    stages.length
  ) {
    throw new HttpError(400, "invalid_request");
  }
  if (action["kind"] === "save") {
    exactKeys(action, ["kind"]);
  } else if (action["kind"] === "archive" && isObject(action["archive"])) {
    exactKeys(action, ["kind", "archive"]);
    const archive = action["archive"];
    exactKeys(archive, ["archiveId", "summary", "startedAt", "completedAt"]);
    if (
      !validId(archive["archiveId"]) ||
      !stage(archive["summary"]) ||
      !Number.isSafeInteger(archive["startedAt"]) ||
      Number(archive["startedAt"]) < 0 ||
      !Number.isSafeInteger(archive["completedAt"]) ||
      Number(archive["completedAt"]) < Number(archive["startedAt"]) ||
      !stages.some((entry) =>
        Object.keys(entry).every(
          (key) =>
            entry[key as keyof StageSummary] ===
            (archive["summary"] as StageSummary)[key as keyof StageSummary],
        ),
      )
    ) {
      throw new HttpError(400, "invalid_request");
    }
  } else throw new HttpError(400, "invalid_request");
  return value as unknown as WorkspacePut;
}
