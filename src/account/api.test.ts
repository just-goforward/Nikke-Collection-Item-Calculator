import { describe, expect, it, vi } from "vitest";
import { createAccountApi, isGoogleAuthorizationUrl } from "./api";
import { EMPTY_WORKSPACE_DOCUMENT } from "./workspaceDocument";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stub(...responses: Array<Response | Error>) {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("No stubbed response left.");
    return next;
  });
  return { api: createAccountApi(fetchImpl), fetchImpl };
}

function requestAt(fetchImpl: ReturnType<typeof stub>["fetchImpl"], index = 0) {
  const [url, init] = fetchImpl.mock.calls[index] ?? [];
  return { url, init, headers: new Headers(init?.headers) };
}

const PUT_BODY = {
  opId: "op-1",
  baseRevision: 3,
  document: EMPTY_WORKSPACE_DOCUMENT,
  action: { kind: "save" as const },
};

describe("account API client", () => {
  it("sends same-origin cookie-only requests with a quoted account context on mutations", async () => {
    const { api, fetchImpl } = stub(
      jsonResponse(200, { status: "saved", revision: 4, replayed: false }),
    );
    expect(await api.putWorkspace("user-1", PUT_BODY)).toEqual({
      ok: true,
      status: 200,
      value: { status: "saved", revision: 4, replayed: false },
    });
    const { url, init, headers } = requestAt(fetchImpl);
    expect(url).toBe("/v1/workspace");
    expect(init).toMatchObject({ method: "PUT", credentials: "same-origin", cache: "no-store" });
    expect(headers.get("If-Account-Match")).toBe('"user-1"');
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Authorization")).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual(PUT_BODY);
  });

  it("reads 409 and 422 workspace results as contract outcomes", async () => {
    const { api } = stub(
      jsonResponse(409, { status: "revision_conflict", revision: 9 }),
      jsonResponse(422, { status: "archive_quota_reached", revision: 9 }),
    );
    expect(await api.putWorkspace("u", PUT_BODY)).toMatchObject({
      ok: true,
      value: { status: "revision_conflict", revision: 9 },
    });
    expect(await api.putWorkspace("u", PUT_BODY)).toMatchObject({
      ok: true,
      value: { status: "archive_quota_reached" },
    });
  });

  it("maps error bodies, invalid bodies and network failures", async () => {
    const { api } = stub(
      jsonResponse(409, { error: "account_context_stale" }),
      jsonResponse(428, { error: "account_context_required" }),
      jsonResponse(200, { authenticated: true }),
      new TypeError("Failed to fetch"),
    );
    expect(await api.putWorkspace("u", PUT_BODY)).toEqual({
      ok: false,
      failure: { kind: "http", status: 409, code: "account_context_stale" },
    });
    expect(await api.putWorkspace("u", PUT_BODY)).toEqual({
      ok: false,
      failure: { kind: "http", status: 428, code: "account_context_required" },
    });
    expect(await api.getAccount()).toEqual({
      ok: false,
      failure: { kind: "http", status: 200, code: null },
    });
    expect(await api.getAccount()).toEqual({ ok: false, failure: { kind: "network" } });
  });

  it("does not hide programming errors as network failures", async () => {
    const { api } = stub(new RangeError("bug"));
    await expect(api.getWorkspace()).rejects.toThrow("bug");
  });

  it("uses the contract bodies for login, logout, consent, deletion and revoke-all", async () => {
    const accepted = { operationId: "p", status: "pending", fenceGeneration: 1 };
    const { api, fetchImpl } = stub(
      jsonResponse(200, { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" }),
      jsonResponse(200, { loggedOut: true }),
      jsonResponse(202, accepted),
      jsonResponse(202, accepted),
      jsonResponse(200, { revoked: true }),
    );
    await api.startLogin();
    await api.logout();
    await api.putConsent("u", { participation: false, baseDecisionVersion: 2, opId: "c" });
    expect(await api.deleteAccount("u", { opId: "d" })).toMatchObject({ ok: true, status: 202 });
    await api.revokeAll("u", { opId: "r" });
    const sent = fetchImpl.mock.calls.map(([url, init]) => [
      init?.method,
      url,
      init?.body ?? null,
      new Headers(init?.headers).get("If-Account-Match"),
    ]);
    expect(sent).toEqual([
      ["POST", "/auth/login/google", "{}", null],
      ["POST", "/auth/logout", null, null],
      ["PUT", "/v1/consent", '{"participation":false,"baseDecisionVersion":2,"opId":"c"}', '"u"'],
      ["DELETE", "/v1/account", '{"opId":"d"}', '"u"'],
      ["POST", "/v1/sessions/revoke-all", '{"opId":"r"}', '"u"'],
    ]);
    for (const [, init] of fetchImpl.mock.calls) expect(init?.credentials).toBe("same-origin");
  });

  it("only follows Google's authorization origin", () => {
    expect(isGoogleAuthorizationUrl("https://accounts.google.com/o/oauth2/v2/auth?x=1")).toBe(true);
    expect(isGoogleAuthorizationUrl("http://accounts.google.com/o/oauth2")).toBe(false);
    expect(isGoogleAuthorizationUrl("https://accounts.google.com.evil.example/")).toBe(false);
    expect(isGoogleAuthorizationUrl("javascript:alert(1)")).toBe(false);
    expect(isGoogleAuthorizationUrl("/relative")).toBe(false);
  });
});
