import type { StageSummary, WorkspaceAction, WorkspacePut } from "./contracts";

export const MAX_BODY_BYTES = 2_000_000;
export type Reason =
  | "invalid_request"
  | "request_too_large"
  | "origin_rejected"
  | "unauthenticated"
  | "auth_failed"
  | "login_flow_expired"
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
export function requireAccountContext(request: Request, userId: string, required = true): void {
  const context = request.headers.get("If-Account-Match");
  if (context === null) {
    if (required) throw new HttpError(428, "account_context_required");
    return;
  }
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
/** Exact arithmetic ceiling for each item and for each lifetime stage total. */
export const MAX_LIFETIME_VALUE = Number.MAX_SAFE_INTEGER;

const STAGE_SUMMARY_KEYS = [
  "itemId",
  "stage",
  "lifetimeAttempts",
  "lifetimeIncome",
  "preSignupIncome",
  "manualEntry",
  "verified",
];

/** A true predicate: invalid input returns false so read paths can classify it, never throw. */
export function stageSummary(value: unknown): value is StageSummary {
  if (!isObject(value) || Object.keys(value).length !== STAGE_SUMMARY_KEYS.length) return false;
  if (Object.keys(value).some((key) => !STAGE_SUMMARY_KEYS.includes(key))) return false;
  const income = value["lifetimeIncome"];
  const previous = value["preSignupIncome"];
  return (
    validId(value["itemId"]) &&
    validId(value["stage"]) &&
    Number.isSafeInteger(value["lifetimeAttempts"]) &&
    Number(value["lifetimeAttempts"]) >= 0 &&
    Number(value["lifetimeAttempts"]) <= MAX_LIFETIME_VALUE &&
    typeof income === "number" &&
    Number.isSafeInteger(income) &&
    income >= 0 &&
    income <= MAX_LIFETIME_VALUE &&
    typeof previous === "number" &&
    Number.isSafeInteger(previous) &&
    previous >= 0 &&
    previous <= MAX_LIFETIME_VALUE &&
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
/** Every stage must be individually valid before any total is computed. */
function stageList(value: unknown): StageSummary[] {
  if (!Array.isArray(value) || !value.every(stageSummary)) {
    throw new HttpError(400, "invalid_request");
  }
  return value;
}

/** Exact arithmetic ceiling for each item and for each lifetime stage total. */
function stageTotalsWithinCeiling(stages: StageSummary[]): void {
  const totals = new Map<string, { income: number; previous: number; attempts: number }>();
  for (const summary of stages) {
    const total = totals.get(summary.stage) ?? { income: 0, previous: 0, attempts: 0 };
    if (
      summary.lifetimeIncome > MAX_LIFETIME_VALUE - total.income ||
      summary.preSignupIncome > MAX_LIFETIME_VALUE - total.previous ||
      summary.lifetimeAttempts > MAX_LIFETIME_VALUE - total.attempts
    ) {
      throw new HttpError(400, "invalid_request");
    }
    total.income += summary.lifetimeIncome;
    total.previous += summary.preSignupIncome;
    total.attempts += summary.lifetimeAttempts;
    totals.set(summary.stage, total);
  }
}

/** Field-by-field because both sides are validated `StageSummary` values. */
function sameSummary(left: StageSummary, right: StageSummary): boolean {
  return (
    left.itemId === right.itemId &&
    left.stage === right.stage &&
    left.lifetimeAttempts === right.lifetimeAttempts &&
    left.lifetimeIncome === right.lifetimeIncome &&
    left.preSignupIncome === right.preSignupIncome &&
    left.manualEntry === right.manualEntry &&
    left.verified === right.verified
  );
}

/** An archive must name a summary the submitted document itself already contains. */
function archiveAction(action: Record<string, unknown>, stages: StageSummary[]): WorkspaceAction {
  if (action["kind"] === "save" && !("archive" in action)) {
    exactKeys(action, ["kind"]);
    return { kind: "save" };
  }
  if (action["kind"] !== "archive" || !isObject(action["archive"])) {
    throw new HttpError(400, "invalid_request");
  }
  exactKeys(action, ["kind", "archive"]);
  const archive = action["archive"];
  exactKeys(archive, ["archiveId", "summary", "startedAt", "completedAt"]);
  const summary = archive["summary"];
  if (
    !validId(archive["archiveId"]) ||
    !stageSummary(summary) ||
    !Number.isSafeInteger(archive["startedAt"]) ||
    Number(archive["startedAt"]) < 0 ||
    !Number.isSafeInteger(archive["completedAt"]) ||
    Number(archive["completedAt"]) < Number(archive["startedAt"]) ||
    !stages.some((entry) => sameSummary(entry, summary))
  ) {
    throw new HttpError(400, "invalid_request");
  }
  return {
    kind: "archive",
    archive: {
      archiveId: archive["archiveId"],
      summary,
      startedAt: Number(archive["startedAt"]),
      completedAt: Number(archive["completedAt"]),
    },
  };
}

export function workspaceBody(value: Record<string, unknown>): WorkspacePut {
  exactKeys(value, ["opId", "baseRevision", "document", "action"]);
  const opId = value["opId"];
  const baseRevision = value["baseRevision"];
  const document = value["document"];
  const action = value["action"];
  if (
    !validId(opId) ||
    !Number.isSafeInteger(baseRevision) ||
    Number(baseRevision) < 0 ||
    !isObject(document) ||
    !isObject(action)
  ) {
    throw new HttpError(400, "invalid_request");
  }
  exactKeys(document, ["schemaVersion", "items", "lifetimeStages"]);
  const items = document["items"];
  if (document["schemaVersion"] !== 1 || !Array.isArray(items) || !boundedJson(items)) {
    throw new HttpError(400, "invalid_request");
  }
  const lifetimeStages = stageList(document["lifetimeStages"]);
  stageTotalsWithinCeiling(lifetimeStages);
  if (
    new Set(lifetimeStages.map((entry) => JSON.stringify([entry.itemId, entry.stage]))).size !==
    lifetimeStages.length
  ) {
    throw new HttpError(400, "invalid_request");
  }
  return {
    opId,
    baseRevision: Number(baseRevision),
    document: { schemaVersion: 1, items, lifetimeStages },
    action: archiveAction(action, lifetimeStages),
  };
}
