import * as z from "zod/mini";
import type {
  ApiErrorCode,
  DeleteAccountRequest,
  PrivacyAccepted,
  RevokeAllRequest,
  RevokeAllResult,
  WorkspaceGet,
  WorkspacePut,
  WorkspacePutResult,
} from "../../personal-data/src/contracts";
import { WorkspaceDocumentSchema } from "./workspaceDocument";

/**
 * Same-origin client for the personal-data contract. Session identity lives only in the
 * HttpOnly cookie: requests use `credentials: "same-origin"` and never carry tokens.
 */
export type ApiFailure =
  | { kind: "network" }
  | { kind: "http"; status: number; code: string | null };
export type ApiResult<T> =
  | { ok: true; status: number; value: T }
  | { ok: false; failure: ApiFailure };

type AccountInfo = {
  authenticated: true;
  account: { userId: string; generation: number };
};

export type AccountApi = {
  getAccount(): Promise<ApiResult<AccountInfo>>;
  startLogin(): Promise<ApiResult<{ authorizationUrl: string }>>;
  logout(): Promise<ApiResult<{ loggedOut: true }>>;
  /**
   * Private reads after GET /v1/account carry the displayed account as If-Account-Match and are
   * answered only for that account: a response for anyone else becomes `account_context_stale`.
   */
  getWorkspace(userId: string): Promise<ApiResult<WorkspaceGet>>;
  putWorkspace(userId: string, body: WorkspacePut): Promise<ApiResult<WorkspacePutResult>>;
  deleteAccount(userId: string, body: DeleteAccountRequest): Promise<ApiResult<PrivacyAccepted>>;
  revokeAll(userId: string, body: RevokeAllRequest): Promise<ApiResult<RevokeAllResult>>;
  exportData(userId: string): Promise<ApiResult<Record<string, unknown>>>;
};

const COUNT = z.int().check(z.minimum(0));
const USER_ID = z.string().check(z.regex(/^[A-Za-z0-9_-]{1,128}$/));
const AccountSchema = z.object({
  authenticated: z.literal(true),
  account: z.object({ userId: USER_ID, generation: COUNT }),
});
const WorkspaceSchema = z.object({
  userId: USER_ID,
  revision: COUNT,
  lastOpId: z.nullable(z.string()),
  document: WorkspaceDocumentSchema,
  quota: z.object({ bytes: COUNT, limitBytes: COUNT, newArchivingBlocked: z.boolean() }),
});
const PutResultSchema = z.union([
  z.object({ status: z.literal("saved"), revision: COUNT, replayed: z.boolean() }),
  z.object({ status: z.literal("revision_conflict"), revision: COUNT }),
  z.object({ status: z.literal("op_id_conflict") }),
  z.object({ status: z.literal("archive_id_conflict") }),
  z.object({ status: z.literal("archive_quota_reached"), revision: COUNT }),
]);
const PrivacyAcceptedSchema = z.object({
  operationId: z.string(),
  status: z.enum(["pending", "complete"]),
  fenceGeneration: COUNT,
});
const ExportSchema = z.looseObject({
  schemaVersion: z.literal(1),
  account: z.looseObject({ userId: USER_ID }),
  workspace: z.looseObject({ userId: USER_ID }),
});
const ErrorSchema = z.object({ error: z.string() });
/** A private read answered for another account is handled exactly like the server's 409. */
const STALE_CONTEXT: ApiResult<never> = {
  ok: false,
  failure: { kind: "http", status: 409, code: "account_context_stale" },
};

type Parser<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
type Outcome = { status: number; json: unknown } | null;
type SendOptions = { body?: unknown; accountId?: string };

export function isHttpFailure(failure: ApiFailure, status: number, code?: ApiErrorCode): boolean {
  return (
    failure.kind === "http" &&
    failure.status === status &&
    (code === undefined || failure.code === code)
  );
}

/** The server builds the authorization URL; only Google's fixed authorization origin is followed. */
export function isGoogleAuthorizationUrl(value: string): boolean {
  return URL.parse(value)?.origin === "https://accounts.google.com";
}

/** Verifies the session owner a private read reports before anything may use the data. */
function owned<T>(
  result: ApiResult<T>,
  userId: string,
  owners: (value: T) => readonly string[],
): ApiResult<T> {
  return result.ok && owners(result.value).some((owner) => owner !== userId)
    ? STALE_CONTEXT
    : result;
}

function interpret<T>(outcome: Outcome, parser: Parser<T>, okStatuses: number[]): ApiResult<T> {
  if (!outcome) return { ok: false, failure: { kind: "network" } };
  if (okStatuses.includes(outcome.status)) {
    const parsed = parser.safeParse(outcome.json);
    if (parsed.success) return { ok: true, status: outcome.status, value: parsed.data };
  }
  const error = ErrorSchema.safeParse(outcome.json);
  return {
    ok: false,
    failure: {
      kind: "http",
      status: outcome.status,
      code: error.success ? error.data.error : null,
    },
  };
}

export function createAccountApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): AccountApi {
  async function send(method: string, path: string, options: SendOptions = {}): Promise<Outcome> {
    const headers = new Headers({ Accept: "application/json" });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    // Displayed-account precondition (quoted, strong); the session cookie stays authoritative.
    if (options.accountId !== undefined) headers.set("If-Account-Match", `"${options.accountId}"`);
    let response: Response;
    try {
      response = await fetchImpl(path, {
        method,
        headers,
        body: options.body === undefined ? null : JSON.stringify(options.body),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
    } catch (error) {
      if (error instanceof TypeError) return null;
      throw error;
    }
    const json: unknown = await response.json().catch(() => null);
    return { status: response.status, json };
  }

  return {
    getAccount: async () => interpret(await send("GET", "/v1/account"), AccountSchema, [200]),
    startLogin: async () =>
      interpret(
        await send("POST", "/auth/login/google", { body: {} }),
        z.object({ authorizationUrl: z.string() }),
        [200],
      ),
    logout: async () =>
      interpret(
        await send("POST", "/auth/logout"),
        z.object({ loggedOut: z.literal(true) }),
        [200],
      ),
    getWorkspace: async (userId) =>
      owned(
        interpret(
          await send("GET", "/v1/workspace", { accountId: userId }),
          WorkspaceSchema,
          [200],
        ),
        userId,
        (value) => [value.userId],
      ),
    putWorkspace: async (userId, body) =>
      interpret(
        await send("PUT", "/v1/workspace", { body, accountId: userId }),
        PutResultSchema,
        [200, 409, 422],
      ),
    deleteAccount: async (userId, body) =>
      interpret(
        await send("DELETE", "/v1/account", { body, accountId: userId }),
        PrivacyAcceptedSchema,
        [200, 202],
      ),
    revokeAll: async (userId, body) =>
      interpret(
        await send("POST", "/v1/sessions/revoke-all", { body, accountId: userId }),
        z.object({ revoked: z.literal(true) }),
        [200],
      ),
    exportData: async (userId) =>
      owned(
        interpret(await send("GET", "/v1/export", { accountId: userId }), ExportSchema, [200]),
        userId,
        (value) => [value.account.userId, value.workspace.userId],
      ),
  };
}
