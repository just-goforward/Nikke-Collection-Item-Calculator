import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLOW_COOKIE,
  FLOW_TTL_MS,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  sha256,
} from "./auth";
import type { AccountCallbackError } from "./contracts";
import { fakeIssuer, TEST_CLIENT, TEST_ORIGIN, TEST_SECRET } from "./fake-issuer";
import { googleProvider } from "./google";
import { HttpError, MAX_BODY_BYTES } from "./http";
import { fixtureEnv, resetFixture } from "./test-fixture";
import type { PersonalEnv } from "./types";
import { createWorker } from "./worker";

const bindings = fixtureEnv();
const databases: PersonalEnv = {
  ...bindings,
  SITE_ORIGIN: TEST_ORIGIN,
  GOOGLE_CLIENT_ID: TEST_CLIENT,
  GOOGLE_CLIENT_SECRET: TEST_SECRET,
};
const put = (opId = "op1", baseRevision = 0) => ({
  opId,
  baseRevision,
  document: { schemaVersion: 1, items: ["personal"], lifetimeStages: [] },
  action: { kind: "save" },
});
function cookieHeader(result: Response): string {
  return result.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .filter((value) => value && !value.endsWith("="))
    .join("; ");
}
async function accountError(result: Response, code: AccountCallbackError) {
  expect(result.status).toBe(303);
  expect(result.headers.get("Location")).toBe(`/?account_error=${code}`);
  expect(result.headers.get("Cache-Control")).toBe("no-store");
  expect(result.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(await result.text()).toBe("");
}
async function count(table: string): Promise<number> {
  const result = await databases.PERSONAL_DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{
    n: number;
  }>();
  return result?.n ?? -1;
}
async function harness() {
  const issuer = await fakeIssuer();
  let time = Date.now();
  const worker = createWorker(issuer.fetch, () => time);
  const accountIds = new Map<string, string>();
  const request = (path: string, init: RequestInit = {}) =>
    worker.fetch(
      new Request(path.startsWith("https:") ? path : `${TEST_ORIGIN}${path}`, init),
      // Explicitly enabled local prototype coverage; beta refusal is tested separately.
      init.method === "PUT" && ["/v1/consent", "/api/personal/settings"].includes(path)
        ? { ...databases, PUBLICATION_ENABLED: "true" }
        : databases,
    );
  const mutate = (path: string, value: unknown, session = "", method = "POST") =>
    request(path, {
      method,
      headers: {
        Origin: TEST_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        Cookie: session,
        ...(((["/v1/workspace", "/v1/consent", "/api/personal/settings"].includes(path) &&
          method === "PUT") ||
          (path === "/v1/account" && method === "DELETE") ||
          (path === "/v1/sessions/revoke-all" && method === "POST")) &&
        accountIds.has(session)
          ? { "If-Account-Match": `"${accountIds.get(session)}"` }
          : {}),
      },
      body: JSON.stringify(value),
    });
  const begin = async () => {
    const result = await mutate("/auth/login/google", {});
    expect(result.status).toBe(200);
    const payload = (await result.json()) as { authorizationUrl: string };
    return { location: payload.authorizationUrl, cookie: cookieHeader(result), result };
  };
  const callback = async (url: string, cookie: string, session = "") =>
    mutate(
      "/auth/callback/google",
      { parameters: new URL(url).search },
      [cookie, session].filter(Boolean).join("; "),
    );
  const login = async (options: Parameters<typeof issuer.authorize>[1] = {}, session = "") => {
    const flow = await begin();
    const url = issuer.authorize(flow.location, options);
    const result = await callback(url, flow.cookie, session);
    const cookie = cookieHeader(result);
    if (result.ok && cookie) {
      const data = (await (
        await request("/v1/account", { headers: { Cookie: cookie } })
      ).json()) as {
        account: { userId: string };
      };
      accountIds.set(cookie, data.account.userId);
    }
    return { flow, url, result, cookie };
  };
  const account = (cookie: string) => request("/api/auth/session", { headers: { Cookie: cookie } });
  return {
    issuer,
    worker,
    request,
    mutate,
    begin,
    callback,
    login,
    account,
    advance(milliseconds: number) {
      time += milliseconds;
    },
    time: () => time,
    alignLane(lane: number) {
      const minute = new Date(time).getUTCMinutes();
      time += ((60 + lane * 10 - minute) % 60) * 60_000;
    },
    accountId: (cookie: string) => accountIds.get(cookie),
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetFixture({ ...databases, ...bindings });
});

describe("Google OIDC through real local D1 HTTP endpoints", () => {
  it("provider discovery builds the fixed authorization URL", async () => {
    const issuer = await fakeIssuer();
    const provider = googleProvider(issuer.fetch);
    const url = await provider.authorizationUrl(databases, "state", "nonce", provider.verifier());
    expect(url.origin).toBe("https://accounts.google.com");
  });
  it("uses fixed issuer/client/redirect, openid-only PKCE and nonce, and an inert no-referrer callback GET", async () => {
    const h = await harness();
    const flow = await h.begin();
    const authorization = new URL(flow.location);
    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("client_id")).toBe(TEST_CLIENT);
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${TEST_ORIGIN}/auth/callback/google`,
    );
    expect(authorization.searchParams.get("scope")).toBe("openid");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("nonce")).toBeTruthy();
    const url = h.issuer.authorize(flow.location);
    const get = await h.request(url, {
      headers: { Cookie: flow.cookie, "Sec-Fetch-Site": "cross-site" },
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(get.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(get.headers.get("Set-Cookie")).toBeNull();
    expect(h.issuer.counts.token).toBe(0);
    expect(await count("oauth_transactions")).toBe(1);
    const result = await h.callback(url, flow.cookie);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ redirect: "/" });
    expect((await h.account(cookieHeader(result))).status).toBe(200);
  });

  it("creates one identity/workspace without email, stores only hashes and never persists provider tokens", async () => {
    const h = await harness();
    const login = await h.login();
    expect(login.result.status).toBe(200);
    const flags = login.result.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${SESSION_COOKIE}=`));
    expect(flags).toMatch(/Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000/);
    expect(flags).not.toContain("Domain=");
    const raw = login.cookie.split("=")[1] ?? "";
    expect(raw).toMatch(/^[a-f0-9]{64}$/);
    const row = await databases.PERSONAL_DB.prepare("SELECT token_hash FROM sessions").first<{
      token_hash: string;
    }>();
    expect(row?.token_hash).toBe(await sha256(raw));
    expect(row?.token_hash).not.toBe(raw);
    expect(await count("accounts")).toBe(1);
    expect(await count("workspaces")).toBe(1);
    const tables = await databases.PERSONAL_DB.batch([
      databases.PERSONAL_DB.prepare("SELECT * FROM accounts"),
      databases.PERSONAL_DB.prepare("SELECT * FROM identities"),
      databases.PERSONAL_DB.prepare("SELECT * FROM sessions"),
    ]);
    expect(JSON.stringify(tables)).not.toMatch(
      /ACCESS_TOKEN_CANARY|REFRESH_TOKEN_CANARY|email|id_token/,
    );
    await h.login({ claims: { sub: "other", email: "same@example.test" } });
    await h.login({ claims: { email: "same@example.test" } });
    expect(await count("accounts")).toBe(2);
    expect(await count("workspaces")).toBe(2);
    expect(h.issuer.counts.discovery).toBe(1);
    expect(h.issuer.counts.jwks).toBe(1);
  });

  it("consumes the flow once before exchange under concurrent callbacks, and failed exchange cannot retry", async () => {
    const h = await harness();
    const flow = await h.begin();
    const url = h.issuer.authorize(flow.location);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => h.callback(url, flow.cookie)),
    );
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(h.issuer.counts.token).toBe(1);
    expect(await count("oauth_transactions")).toBe(0);
    await accountError(await h.callback(url, flow.cookie), "login_flow_expired");
    const failed = await h.login({ failExchange: true });
    await accountError(failed.result, "unknown");
    const previous = h.issuer.counts.token;
    await accountError(await h.callback(failed.url, failed.flow.cookie), "login_flow_expired");
    expect(h.issuer.counts.token).toBe(previous);
  });

  it("rejects invalid signature, missing iss/aud/exp, issuer, audience, nonce, azp and PKCE", async () => {
    const h = await harness();
    for (const options of [
      { badSignature: true },
      { missing: ["iss"] },
      { missing: ["aud"] },
      { missing: ["exp"] },
      { claims: { iss: "https://evil.example" } },
      { claims: { aud: "other-client" } },
      { claims: { nonce: "wrong" } },
      { claims: { azp: "unexpected-party" } },
      { claims: { aud: [TEST_CLIENT, "other"], azp: "unexpected-party" } },
      { challenge: "wrong-pkce" },
    ]) {
      // Distinct trusted ingress addresses isolate the separate login-rate policy.
      h.advance(60_000);
      const login = await h.login(options);
      await accountError(login.result, "unknown");
      await accountError(await h.callback(login.url, login.flow.cookie), "login_flow_expired");
    }
    expect(await count("accounts")).toBe(0);
    expect(await count("sessions")).toBe(0);
  });

  it("accepts only canonical Google issuer; bare accounts.google.com is rejected, never a second identity", async () => {
    const h = await harness();
    expect((await h.login()).result.status).toBe(200);
    const bare = await h.login({ claims: { iss: "accounts.google.com" } });
    await accountError(bare.result, "google_issuer_unsupported");
    await accountError(
      (await h.login({ claims: { iss: "https://wrong.example" } })).result,
      "unknown",
    );
    expect((await h.login()).result.status).toBe(200);
    expect(await count("identities")).toBe(1);
  });

  it("applies the explicit 30-second JWT tolerance but never tolerates session deadlines", async () => {
    const h = await harness();
    const seconds = Math.floor(Date.now() / 1_000);
    expect((await h.login({ claims: { exp: seconds - 20 } })).result.status).toBe(200);
    await accountError((await h.login({ claims: { exp: seconds - 40 } })).result, "unknown");
    const valid = await h.login();
    h.advance(1);
    await databases.PERSONAL_DB.prepare("UPDATE sessions SET idle_expires_at = ?")
      .bind(h.time())
      .run();
    expect((await h.account(valid.cookie)).status).toBe(401);
  });

  it("shares configuration/JWKS for concurrent cold starts in one isolate and separate isolates fail safely", async () => {
    const h = await harness();
    const flows = await Promise.all(Array.from({ length: 8 }, () => h.begin()));
    expect(h.issuer.counts.discovery).toBe(1);
    const results = await Promise.all(
      flows.map((flow) => h.callback(h.issuer.authorize(flow.location), flow.cookie)),
    );
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(h.issuer.counts.jwks).toBe(1);
    expect(await count("accounts")).toBe(1);
    expect(await count("sessions")).toBe(8);
    h.advance(60_000);
    // Independent worker factories represent independent caches; no shared credentials/cache storage.
    const second = createWorker(h.issuer.fetch, h.time);
    const third = createWorker(h.issuer.fetch, h.time);
    await Promise.all(
      [second, third].map((worker) =>
        worker.fetch(
          new Request(`${TEST_ORIGIN}/auth/login/google`, {
            method: "POST",
            headers: { Origin: TEST_ORIGIN, "Content-Type": "application/json" },
            body: "{}",
          }),
          databases,
        ),
      ),
    );
    expect(h.issuer.counts.discovery).toBe(3);
  });

  it("unknown kid fails closed during cooldown; rotation succeeds after the library refresh interval", async () => {
    const h = await harness();
    expect((await h.login()).result.status).toBe(200);
    h.issuer.rotate();
    await accountError((await h.login()).result, "unknown");
    expect(h.issuer.counts.jwks).toBe(1);
    const time = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(time + 61_000);
    expect((await h.login()).result.status).toBe(200);
    expect(h.issuer.counts.jwks).toBe(2);
    await accountError((await h.login({ kid: "unpublished-key" })).result, "unknown");
  });

  it("discovery and JWKS outages expose no exceptions and consumed callbacks require a new login", async () => {
    const h = await harness();
    h.issuer.outage("discovery");
    const failed = await h.mutate("/auth/login/google", {});
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "service_unavailable" });
    expect(await count("oauth_transactions")).toBe(0);
    h.issuer.outage("jwks");
    const login = await h.login();
    await accountError(login.result, "unknown");
    await accountError(await h.callback(login.url, login.flow.cookie), "login_flow_expired");
    h.issuer.outage(null);
    expect((await h.login()).result.status).toBe(200);
  });

  it("bounds outbound timeout and rejects discovery endpoint substitution without following it", async () => {
    const h = await harness();
    h.issuer.metadata({ token_endpoint: "https://evil.example/token" });
    expect((await h.mutate("/auth/login/google", {})).status).toBe(503);
    h.issuer.metadata({});
    h.issuer.hang("discovery");
    const result = await h.mutate("/auth/login/google", {});
    expect(result.status).toBe(503);
    expect(h.issuer.counts.token).toBe(0);
  }, 10_000);
});

describe("authorization, ownership, session activity and revocation HTTP contracts", () => {
  it("refuses a different identity without replacing the current session; same identity can refresh", async () => {
    const h = await harness();
    const alice = await h.login();
    const other = await h.login({ claims: { sub: "bob" } }, alice.cookie);
    await accountError(other.result, "account_switch_requires_logout");
    expect(
      other.result.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`)),
    ).toBe(false);
    expect((await h.account(alice.cookie)).status).toBe(200);
    expect(await count("accounts")).toBe(1);
    expect(await count("sessions")).toBe(1);
    const refreshed = await h.login({}, alice.cookie);
    expect(refreshed.result.status).toBe(200);
    expect(h.accountId(refreshed.cookie)).toBe(h.accountId(alice.cookie));
    expect(await count("accounts")).toBe(1);
  });

  it("cross-tab account preconditions reject stale or absent identity context, never choose ownership", async () => {
    const h = await harness();
    const alice = await h.login();
    await h.mutate("/auth/logout", {}, alice.cookie);
    const bob = await h.login({ claims: { sub: "bob" } });
    const state = (await (await h.account(bob.cookie)).json()) as {
      account: { userId: string; generation: number };
    };
    expect(state.account).toEqual({ userId: h.accountId(bob.cookie), generation: 0 });
    const write = (context?: string) =>
      h.request("/v1/workspace", {
        method: "PUT",
        headers: {
          Origin: TEST_ORIGIN,
          Cookie: bob.cookie,
          "Content-Type": "application/json",
          ...(context ? { "If-Account-Match": context } : {}),
        },
        body: JSON.stringify(put()),
      });
    expect(await (await write(`"${h.accountId(alice.cookie)}"`)).json()).toEqual({
      error: "account_context_stale",
    });
    expect((await write("*")).status).toBe(409);
    expect((await write()).status).toBe(428);
    expect((await h.request("/v1/workspace", { headers: { Cookie: bob.cookie } })).status).toBe(
      200,
    );
    expect(
      (
        await databases.PERSONAL_DB.prepare("SELECT max(revision) AS n FROM workspaces").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
    expect((await write(`"${state.account.userId}"`)).status).toBe(200);
  });

  it("private reads bind to displayed identity when supplied and identify the session otherwise", async () => {
    const h = await harness();
    const alice = await h.login();
    expect((await h.mutate("/v1/workspace", put(), alice.cookie, "PUT")).status).toBe(200);
    const displayed = (await (await h.account(alice.cookie)).json()) as {
      account: { userId: string };
    };
    await h.mutate("/auth/logout", {}, alice.cookie);
    const bob = await h.login({ claims: { sub: "bob" } });
    const bobId = h.accountId(bob.cookie)!;
    const document = { schemaVersion: 1, items: ["bob-private"], lifetimeStages: [] };
    expect(
      (await h.mutate("/v1/workspace", { ...put(), document }, bob.cookie, "PUT")).status,
    ).toBe(200);
    const rank = {
      releaseId: "published",
      stage: "R",
      percentileBand: { lower: 40, upper: 50 },
      manualEntry: true,
      verified: false,
    };
    await databases.PUBLIC_AGGREGATE_DB.batch([
      databases.PUBLIC_AGGREGATE_DB.prepare("UPDATE privacy_fence SET blocked = 0"),
      databases.PUBLIC_AGGREGATE_DB.prepare(
        `INSERT INTO weekly_releases (release_id, week_start, fence_generation, payload, published_at)
         VALUES ('published', '2026-10-12', 0, '{}', ?)`,
      ).bind(h.time()),
    ]);
    await databases.PERSONAL_DB.prepare(
      "INSERT INTO self_percentiles VALUES (?, 'published', 'R', ?)",
    )
      .bind(bobId, JSON.stringify(rank))
      .run();
    const read = (path: string, headers: HeadersInit) =>
      h.worker.fetch(new Request(`${TEST_ORIGIN}${path}`, { headers }), {
        ...databases,
        PUBLICATION_ENABLED: "true",
      });
    const expected = [
      { path: "/v1/account", data: { account: { userId: bobId } } },
      { path: "/api/auth/session", data: { account: { userId: bobId } } },
      { path: "/v1/workspace", data: { userId: bobId, revision: 1, document } },
      {
        path: "/v1/export",
        data: {
          account: { userId: bobId },
          workspace: { userId: bobId, document },
          selfPercentiles: [rank],
        },
      },
      {
        path: "/v1/consent",
        data: { userId: bobId, participation: null, decisionVersion: 0 },
      },
      {
        path: "/api/personal/settings",
        data: { userId: bobId, participation: null, decisionVersion: 0 },
      },
      { path: "/v1/self-percentile", data: { userId: bobId, results: [rank] } },
    ];
    for (const { path, data } of expected) {
      for (const context of [
        `"${displayed.account.userId}"`,
        "*",
        `W/"${bobId}"`,
        bobId,
        "",
        `"${bobId}", "${displayed.account.userId}"`,
      ]) {
        const result = await read(path, { Cookie: bob.cookie, "If-Account-Match": context });
        expect(result.status).toBe(409);
        expect(await result.json()).toEqual({ error: "account_context_stale" });
        expect(result.headers.get("Cache-Control")).toBe("no-store");
      }
      for (const context of [undefined, `"${bobId}"`]) {
        const result = await read(path, {
          Cookie: bob.cookie,
          ...(context === undefined ? {} : { "If-Account-Match": context }),
        });
        expect(result.status).toBe(200);
        expect(await result.json()).toMatchObject(data);
        expect(result.headers.get("Cache-Control")).toBe("no-store");
      }
    }
  });

  it("stale, colliding and replayed consent PUTs do not bump the fence", async () => {
    const h = await harness();
    const login = await h.login();
    const input = { opId: "first-consent", baseDecisionVersion: 0, participation: true };
    expect((await h.mutate("/v1/consent", input, login.cookie, "PUT")).status).toBe(200);
    const generation = async () =>
      (
        await databases.PUBLIC_AGGREGATE_DB.prepare("SELECT generation FROM privacy_fence").first<{
          generation: number;
        }>()
      )?.generation;
    expect(await generation()).toBe(1);
    expect((await h.mutate("/v1/consent", input, login.cookie, "PUT")).status).toBe(200);
    expect(await generation()).toBe(1);
    const stale = await h.mutate("/v1/consent", { ...input, opId: "stale" }, login.cookie, "PUT");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "revision_conflict" });
    const collision = await h.mutate(
      "/v1/consent",
      { ...input, participation: false },
      login.cookie,
      "PUT",
    );
    expect(collision.status).toBe(409);
    expect(await collision.json()).toEqual({ error: "op_id_conflict" });
    expect(await generation()).toBe(1);
  });

  it("deletion, consent and revoke-all require the displayed account before any mutation", async () => {
    const h = await harness();
    const alice = await h.login();
    await h.mutate("/auth/logout", {}, alice.cookie);
    let bob = await h.login({ claims: { sub: "bob" } });
    const bobId = h.accountId(bob.cookie);
    const attempts = [
      { path: "/v1/account", method: "DELETE", input: { opId: "delete" } },
      {
        path: "/v1/consent",
        method: "PUT",
        input: { opId: "consent", baseDecisionVersion: 0, participation: true },
      },
      {
        path: "/api/personal/settings",
        method: "PUT",
        input: { opId: "settings", baseDecisionVersion: 0, participation: true },
      },
      { path: "/v1/sessions/revoke-all", method: "POST", input: { opId: "revoke" } },
    ];
    for (const attempt of attempts) {
      for (const context of [undefined, `"${h.accountId(alice.cookie)}"`, "*", `W/"${bobId}"`]) {
        const result = await h.request(attempt.path, {
          method: attempt.method,
          headers: {
            Origin: TEST_ORIGIN,
            Cookie: bob.cookie,
            "Content-Type": "application/json",
            ...(context === undefined ? {} : { "If-Account-Match": context }),
          },
          body: JSON.stringify(attempt.input),
        });
        expect(result.status).toBe(context === undefined ? 428 : 409);
        expect(await result.json()).toEqual({
          error: context === undefined ? "account_context_required" : "account_context_stale",
        });
        expect(result.headers.get("Cache-Control")).toBe("no-store");
      }
    }
    expect(await count("accounts")).toBe(2);
    expect(await count("sessions")).toBe(1);
    expect(await count("deletion_jobs")).toBe(0);
    expect(
      (
        await databases.PUBLIC_AGGREGATE_DB.prepare("SELECT generation FROM privacy_fence").first<{
          generation: number;
        }>()
      )?.generation,
    ).toBe(0);
    expect(
      (
        await databases.PERSONAL_DB.prepare("SELECT epoch FROM auth_control").first<{
          epoch: number;
        }>()
      )?.epoch,
    ).toBe(0);
    expect(
      (
        await databases.PRIVACY_CONTROL_DB.prepare(
          "SELECT count(*) AS n FROM consent_reservations",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect((await h.mutate("/v1/consent", attempts[1]?.input, bob.cookie, "PUT")).status).toBe(200);
    expect(
      (await h.mutate("/v1/sessions/revoke-all", { opId: "matching-revoke" }, bob.cookie)).status,
    ).toBe(200);
    expect((await h.account(bob.cookie)).status).toBe(401);
    bob = await h.login({ claims: { sub: "bob" } });
    expect(h.accountId(bob.cookie)).toBe(bobId);
    expect(
      (await h.mutate("/v1/account", { opId: "matching-delete" }, bob.cookie, "DELETE")).status,
    ).toBe(202);
    expect(await count("accounts")).toBe(1);
    expect(
      (
        await databases.PERSONAL_DB.prepare("SELECT user_id FROM accounts").first<{
          user_id: string;
        }>()
      )?.user_id,
    ).toBe(h.accountId(alice.cookie));
  });

  it("failed reserved consent is isolated and a matching retry resumes it idempotently", async () => {
    const h = await harness();
    const alice = await h.login();
    const bob = await h.login({ claims: { sub: "bob" } });
    const publicDb = databases.PUBLIC_AGGREGATE_DB;
    const unavailable: PersonalEnv = {
      ...databases,
      PUBLICATION_ENABLED: "true",
      PUBLIC_AGGREGATE_DB: {
        prepare(sql) {
          if (sql.startsWith("UPDATE privacy_fence")) throw new Error("PRIVATE_FAILURE_CANARY");
          return publicDb.prepare(sql);
        },
        batch: (statements) => publicDb.batch(statements),
        exec: (sql) => publicDb.exec(sql),
      },
    };
    const input = { opId: "reserved", baseDecisionVersion: 0, participation: true };
    const failed = await h.worker.fetch(
      new Request(`${TEST_ORIGIN}/v1/consent`, {
        method: "PUT",
        headers: {
          Origin: TEST_ORIGIN,
          Cookie: alice.cookie,
          "Content-Type": "application/json",
          "If-Account-Match": `"${h.accountId(alice.cookie)}"`,
        },
        body: JSON.stringify(input),
      }),
      unavailable,
    );
    expect(failed.status).toBe(503);
    expect(
      await (await h.request("/v1/consent", { headers: { Cookie: alice.cookie } })).json(),
    ).toEqual({ userId: h.accountId(alice.cookie), participation: null, decisionVersion: 0 });
    expect((await h.account(bob.cookie)).status).toBe(200);
    expect((await h.mutate("/v1/consent", input, alice.cookie, "PUT")).status).toBe(200);
    expect((await h.mutate("/v1/consent", input, alice.cookie, "PUT")).status).toBe(200);
    expect(
      (
        await databases.PUBLIC_AGGREGATE_DB.prepare("SELECT generation FROM privacy_fence").first<{
          generation: number;
        }>()
      )?.generation,
    ).toBe(1);
  });

  it("export includes every quota-counted owned row and account timestamps even with consent off", async () => {
    const h = await harness();
    const login = await h.login();
    const created = h.time();
    h.advance(1);
    const summary = {
      itemId: "item",
      stage: "R",
      lifetimeAttempts: 1,
      lifetimeIncome: 2,
      preSignupIncome: 1,
      manualEntry: true,
      verified: false,
    };
    const archive = { archiveId: "archive", summary, startedAt: created, completedAt: h.time() };
    const document = { schemaVersion: 1, items: ["一😀é"], lifetimeStages: [summary] };
    const input = {
      opId: "archive-op",
      baseRevision: 0,
      document,
      action: { kind: "archive", archive },
    };
    expect((await h.mutate("/v1/workspace", input, login.cookie, "PUT")).status).toBe(200);
    const duplicate = await h.mutate(
      "/v1/workspace",
      { ...input, opId: "another-op", baseRevision: 1 },
      login.cookie,
      "PUT",
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ status: "archive_id_conflict" });
    await h.mutate(
      "/v1/consent",
      {
        opId: "exclude",
        baseDecisionVersion: 0,
        participation: false,
      },
      login.cookie,
      "PUT",
    );
    const rank = {
      releaseId: "unavailable",
      stage: "R",
      percentileBand: { lower: 40, upper: 50 },
      manualEntry: true,
      verified: false,
    };
    await databases.PERSONAL_DB.prepare(
      "INSERT INTO self_percentiles VALUES (?, 'unavailable', 'R', ?)",
    )
      .bind(h.accountId(login.cookie) ?? "", JSON.stringify(rank))
      .run();
    const exported = await (
      await h.request("/v1/export", { headers: { Cookie: login.cookie } })
    ).json();
    const bytes = [document, summary, archive].reduce(
      (total, value) => total + new TextEncoder().encode(JSON.stringify(value)).byteLength,
      0,
    );
    expect(exported).toMatchObject({
      account: { userId: h.accountId(login.cookie), createdAt: created, lastActiveAt: h.time() },
      workspace: { revision: 1, document, quota: { bytes } },
      stages: [summary],
      pendingArchives: [archive],
      selfPercentiles: [],
      consent: { participation: false, decisionVersion: 1 },
    });
    expect(
      await (await h.request("/v1/self-percentile", { headers: { Cookie: login.cookie } })).json(),
    ).toEqual({ error: "feature_unavailable" });
  });

  it("concurrent HTTP callbacks admit exactly 150 of 160 distinct identities without orphan rows", async () => {
    const h = await harness();
    const flows: { location: string; cookie: string; sub: string }[] = [];
    for (const base of [0, 80]) {
      const chunk = await Promise.all(
        Array.from({ length: 80 }, async (_, offset) => {
          const index = base + offset;
          const result = await h.request("/auth/login/google", {
            method: "POST",
            headers: {
              Origin: TEST_ORIGIN,
              "Content-Type": "application/json",
              "CF-Connecting-IP": `198.51.100.${index}`,
            },
            body: "{}",
          });
          expect(result.status).toBe(200);
          const data = (await result.json()) as { authorizationUrl: string };
          return {
            location: data.authorizationUrl,
            cookie: cookieHeader(result),
            sub: `http-${index}`,
          };
        }),
      );
      flows.push(...chunk);
      h.advance(60_000);
    }
    const results = await Promise.all(
      flows.map((flow) =>
        h.callback(h.issuer.authorize(flow.location, { claims: { sub: flow.sub } }), flow.cookie),
      ),
    );
    expect(results.filter((result) => result.status === 200)).toHaveLength(150);
    const rejected = results.filter((result) => result.status === 303);
    expect(rejected).toHaveLength(10);
    for (const result of rejected) await accountError(result, "admission_full");
    for (const table of ["accounts", "identities", "workspaces", "sessions"])
      expect(await count(table)).toBe(150);
  }, 30_000);

  it("expiry maintenance removes temporary identity hashes without deleting accounts or privacy tombstones", async () => {
    const h = await harness();
    const old = await h.login();
    await h.mutate("/v1/account", { opId: "delete" }, old.cookie, "DELETE");
    const fresh = await h.login();
    expect(fresh.result.status).toBe(200);
    h.advance(FLOW_TTL_MS);
    await h.worker.scheduled({ scheduledTime: h.time() }, databases);
    expect(await count("identity_deletion_fences")).toBe(0);
    expect(await count("accounts")).toBe(1);
    expect(
      (
        await databases.PRIVACY_CONTROL_DB.prepare("SELECT count(*) AS n FROM tombstones").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
  });

  it("workspace CAS/replay, export, consent and existing site aliases all derive ownership from session", async () => {
    const h = await harness();
    const alice = await h.login();
    const bob = await h.login({ claims: { sub: "bob" } });
    const unauthenticated = await h.request("/v1/workspace");
    expect(unauthenticated.status).toBe(401);
    const consent = await h.request("/api/personal/settings", {
      headers: { Cookie: alice.cookie },
    });
    expect(await consent.json()).toEqual({
      userId: h.accountId(alice.cookie),
      participation: null,
      decisionVersion: 0,
    });
    const saved = await h.mutate("/v1/workspace", put(), alice.cookie, "PUT");
    expect(await saved.json()).toEqual({ status: "saved", revision: 1, replayed: false });
    expect((await h.mutate("/v1/workspace", put(), alice.cookie, "PUT")).status).toBe(200);
    expect((await h.mutate("/v1/workspace", put("stale"), alice.cookie, "PUT")).status).toBe(409);
    expect(
      (await h.mutate("/v1/workspace", { ...put(), userId: "bob" }, alice.cookie, "PUT")).status,
    ).toBe(400);
    const bobWorkspace = await h.request("/v1/workspace", { headers: { Cookie: bob.cookie } });
    expect(((await bobWorkspace.json()) as { revision: number }).revision).toBe(0);
    const exported = await h.request("/v1/export", { headers: { Cookie: alice.cookie } });
    expect(await exported.json()).toMatchObject({
      schemaVersion: 1,
      workspace: { revision: 1, document: { items: ["personal"] } },
      pendingArchives: [],
      stages: [],
      selfPercentiles: [],
    });
    const input = { opId: "optin", baseDecisionVersion: 0, participation: true };
    expect(
      await (await h.mutate("/api/personal/settings", input, alice.cookie, "PUT")).json(),
    ).toEqual({ participation: true, decisionVersion: 1 });
    expect((await h.mutate("/v1/consent", input, alice.cookie, "PUT")).status).toBe(200);
    expect(
      (await h.mutate("/v1/consent", { ...input, participation: false }, alice.cookie, "PUT"))
        .status,
    ).toBe(409);
    expect(
      (
        await h.mutate(
          "/v1/consent",
          {
            opId: "withdraw",
            baseDecisionVersion: 1,
            participation: false,
          },
          alice.cookie,
          "PUT",
        )
      ).status,
    ).toBe(200);
    expect((await h.request("/v1/workspace", { headers: { Cookie: alice.cookie } })).status).toBe(
      200,
    );
    expect(
      (
        await h.mutate(
          "/v1/consent",
          {
            opId: "reoptin",
            baseDecisionVersion: 2,
            participation: true,
          },
          alice.cookie,
          "PUT",
        )
      ).status,
    ).toBe(200);
    expect(await count("accounts")).toBe(2);
  });

  it("only successful login and winning saves refresh account inactivity, not polling, consent, replay or conflicts", async () => {
    const h = await harness();
    const login = await h.login();
    const lastActive = async () =>
      (
        await databases.PERSONAL_DB.prepare("SELECT last_active_at FROM accounts").first<{
          last_active_at: number;
        }>()
      )?.last_active_at;
    const loggedInAt = h.time();
    expect(await lastActive()).toBe(loggedInAt);
    h.advance(60_000);
    for (const path of ["/v1/account", "/v1/workspace", "/v1/export", "/v1/consent"]) {
      expect((await h.request(path, { headers: { Cookie: login.cookie } })).status).toBe(200);
    }
    expect(
      (
        await h.mutate(
          "/v1/consent",
          { opId: "consent-activity", baseDecisionVersion: 0, participation: true },
          login.cookie,
          "PUT",
        )
      ).status,
    ).toBe(200);
    expect(await lastActive()).toBe(loggedInAt);
    expect((await h.mutate("/v1/workspace", put(), login.cookie, "PUT")).status).toBe(200);
    const savedAt = h.time();
    expect(await lastActive()).toBe(savedAt);
    h.advance(60_000);
    expect((await h.mutate("/v1/workspace", put(), login.cookie, "PUT")).status).toBe(200);
    expect(
      (await h.mutate("/v1/workspace", put("conflicting-save"), login.cookie, "PUT")).status,
    ).toBe(409);
    expect(await lastActive()).toBe(savedAt);
    expect((await h.login({}, login.cookie)).result.status).toBe(200);
    expect(await lastActive()).toBe(h.time());
  });

  it("background reads do not refresh; successful user saves refresh idle/cookie only up to absolute max", async () => {
    const h = await harness();
    const login = await h.login();
    const original = await databases.PERSONAL_DB.prepare(
      "SELECT idle_expires_at, max_expires_at FROM sessions",
    ).first<{ idle_expires_at: number; max_expires_at: number }>();
    h.advance(29 * 86_400_000);
    const get = await h.account(login.cookie);
    expect(get.status).toBe(200);
    expect(get.headers.get("Set-Cookie")).toBeNull();
    expect(
      (
        await databases.PERSONAL_DB.prepare("SELECT idle_expires_at FROM sessions").first<{
          idle_expires_at: number;
        }>()
      )?.idle_expires_at,
    ).toBe(original?.idle_expires_at);
    const saved = await h.mutate("/v1/workspace", put(), login.cookie, "PUT");
    expect(saved.headers.get("Set-Cookie")).toContain("Max-Age=2592000");
    h.advance(29 * 86_400_000);
    await h.mutate("/v1/workspace", put("next", 1), login.cookie, "PUT");
    h.advance(29 * 86_400_000);
    const near = await h.mutate("/v1/workspace", put("near", 2), login.cookie, "PUT");
    expect(near.headers.get("Set-Cookie")).toContain("Max-Age=259200");
    expect(
      (
        await databases.PERSONAL_DB.prepare("SELECT max_expires_at FROM sessions").first<{
          max_expires_at: number;
        }>()
      )?.max_expires_at,
    ).toBe(original?.max_expires_at);
    h.advance(3 * 86_400_000);
    expect((await h.account(login.cookie)).status).toBe(401);
    expect(SESSION_MAX_MS).toBe(90 * 86_400_000);
    expect(SESSION_IDLE_MS).toBe(30 * 86_400_000);
  });

  it("revoke-all rejects a callback paused before session creation, including an anonymous pre-revocation flow", async () => {
    const h = await harness();
    const current = await h.login();
    const lastLogin = h.time();
    const pending = await h.begin();
    const url = h.issuer.authorize(pending.location);
    const gate = h.issuer.pauseNextExchange();
    const callback = h.callback(url, pending.cookie);
    await gate.entered;
    h.advance(60_000);
    expect(await count("oauth_transactions")).toBe(0);
    expect(
      (await h.mutate("/v1/sessions/revoke-all", { opId: "revoke" }, current.cookie)).status,
    ).toBe(200);
    gate.release();
    await accountError(await callback, "unknown");
    expect(await count("sessions")).toBe(0);
    expect(
      (
        await databases.PERSONAL_DB.prepare("SELECT last_active_at FROM accounts").first<{
          last_active_at: number;
        }>()
      )?.last_active_at,
    ).toBe(lastLogin);
    expect((await h.account(current.cookie)).status).toBe(401);
    expect((await h.login()).result.status).toBe(200); // Only a fresh flow is admitted.
  });

  it("revoke-all after callback creation deletes that new session too; logout only deletes current session", async () => {
    const h = await harness();
    const first = await h.login();
    const second = await h.login();
    expect((await h.mutate("/api/auth/logout", {}, first.cookie)).status).toBe(200);
    expect((await h.account(first.cookie)).status).toBe(401);
    expect((await h.account(second.cookie)).status).toBe(200);
    const third = await h.login();
    expect((await h.mutate("/v1/sessions/revoke-all", { opId: "all" }, second.cookie)).status).toBe(
      200,
    );
    expect((await h.account(second.cookie)).status).toBe(401);
    expect((await h.account(third.cookie)).status).toBe(401);
    expect(await count("accounts")).toBe(1);
  });

  it("logout accepts the browser's bodiless request as an empty stream, with or without Content-Length", async () => {
    const h = await harness();
    for (const [path, method, length] of [
      ["/auth/logout", "POST", { "Content-Length": "0" }],
      ["/api/auth/logout", "POST", { "Content-Length": "0" }],
      ["/api/auth/session", "DELETE", {}],
    ] as const) {
      const session = await h.login();
      const result = await h.worker.fetch(
        new Request(`${TEST_ORIGIN}${path}`, {
          method,
          headers: {
            Origin: TEST_ORIGIN,
            "Sec-Fetch-Site": "same-origin",
            Accept: "application/json",
            ...length,
            Cookie: session.cookie,
          },
          body: new Uint8Array(0),
        }),
        databases,
      );
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ loggedOut: true });
      expect(result.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
      expect((await h.account(session.cookie)).status).toBe(401);
    }
    const kept = await h.login();
    for (const headers of [{}, { "Content-Length": "0" }]) {
      const nonEmpty = await h.worker.fetch(
        new Request(`${TEST_ORIGIN}/auth/logout`, {
          method: "POST",
          headers: {
            Origin: TEST_ORIGIN,
            "Sec-Fetch-Site": "same-origin",
            Cookie: kept.cookie,
            ...headers,
          },
          body: new TextEncoder().encode("x"),
        }),
        databases,
      );
      expect(nonEmpty.status).toBe(400);
    }
    expect((await h.account(kept.cookie)).status).toBe(200);
  });

  it("deletion blocks pre-deletion callbacks while a fresh login rejoins with a new account", async () => {
    const h = await harness();
    const current = await h.login();
    await h.mutate("/v1/workspace", put(), current.cookie, "PUT");
    const pending = await h.begin();
    const gate = h.issuer.pauseNextExchange();
    const callback = h.callback(h.issuer.authorize(pending.location), pending.cookie);
    await gate.entered;
    expect(
      (await h.mutate("/v1/account", { opId: "delete" }, current.cookie, "DELETE")).status,
    ).toBe(202);
    gate.release();
    await accountError(await callback, "unknown");
    expect(await count("accounts")).toBe(0);
    const rejoined = await h.login();
    expect(rejoined.result.status).toBe(200);
    expect(await count("accounts")).toBe(1);
    expect(h.accountId(rejoined.cookie)).not.toBe(h.accountId(current.cookie));
    expect(await count("identity_deletion_fences")).toBe(1);
  });

  it("a deletion privacy-write failure keeps the public fence and durable deny/outbox until retry", async () => {
    const h = await harness();
    const login = await h.login();
    const privacy = databases.PRIVACY_CONTROL_DB;
    const unavailable: PersonalEnv = {
      ...databases,
      PRIVACY_CONTROL_DB: {
        prepare(sql) {
          if (sql.includes("INSERT INTO privacy_operations"))
            throw new Error("RAW_EXCEPTION_CANARY");
          return privacy.prepare(sql);
        },
        batch: (statements) => privacy.batch(statements),
        exec: (sql) => privacy.exec(sql),
      },
    };
    const result = await h.worker.fetch(
      new Request(`${TEST_ORIGIN}/v1/account`, {
        method: "DELETE",
        headers: {
          Origin: TEST_ORIGIN,
          Cookie: login.cookie,
          "Content-Type": "application/json",
          "If-Account-Match": `"${h.accountId(login.cookie)}"`,
        },
        body: JSON.stringify({ opId: "delete-failure" }),
      }),
      unavailable,
    );
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "service_unavailable" });
    expect(await count("sessions")).toBe(0);
    expect(await count("deletion_jobs")).toBe(1);
    expect(
      (
        await databases.PUBLIC_AGGREGATE_DB.prepare("SELECT blocked FROM privacy_fence").first<{
          blocked: number;
        }>()
      )?.blocked,
    ).toBe(1);
    expect((await h.request("/v1/statistics")).status).toBe(404);
    expect(await count("deletion_jobs")).toBe(1); // Public/unrelated requests do not drain the outbox.
    expect((await h.login()).result.status).toBe(200); // Only this identity retries its one job.
    expect(await count("deletion_jobs")).toBe(0);
    expect((await h.account(login.cookie)).status).toBe(401);
  });

  it("a failed deletion completes by cron without login, removes owned rows and frees an admission slot", async () => {
    const h = await harness();
    h.alignLane(1);
    const login = await h.login();
    const userId = h.accountId(login.cookie) ?? "";
    await h.mutate("/v1/workspace", put(), login.cookie, "PUT");
    await databases.PERSONAL_DB.batch([
      databases.PERSONAL_DB.prepare(
        `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<149)
         INSERT INTO accounts (user_id, created_at, last_active_at)
         SELECT 'cron-slot-' || x, ?, ? FROM n`,
      ).bind(h.time(), h.time()),
      databases.PERSONAL_DB.prepare(
        "INSERT INTO identities SELECT 'https://accounts.google.com', user_id, user_id FROM accounts WHERE user_id LIKE 'cron-slot-%'",
      ),
      databases.PERSONAL_DB.prepare(
        `INSERT INTO workspaces (user_id, document)
         SELECT user_id, '{"schemaVersion":1,"items":[],"lifetimeStages":[]}'
         FROM accounts WHERE user_id LIKE 'cron-slot-%'`,
      ),
    ]);
    const privacy = databases.PRIVACY_CONTROL_DB;
    const unavailable: PersonalEnv = {
      ...databases,
      PRIVACY_CONTROL_DB: {
        prepare(sql) {
          if (sql.startsWith("INSERT INTO privacy_operations")) throw new Error("local_transient");
          return privacy.prepare(sql);
        },
        batch: (statements) => privacy.batch(statements),
        exec: (sql) => privacy.exec(sql),
      },
    };
    const failed = await h.worker.fetch(
      new Request(`${TEST_ORIGIN}/v1/account`, {
        method: "DELETE",
        headers: {
          Origin: TEST_ORIGIN,
          Cookie: login.cookie,
          "Content-Type": "application/json",
          "If-Account-Match": `"${userId}"`,
        },
        body: JSON.stringify({ opId: "cron-delete" }),
      }),
      unavailable,
    );
    expect(failed.status).toBe(503);
    expect((await h.account(login.cookie)).status).toBe(401);
    expect(await count("accounts")).toBe(150);
    await accountError(
      (await h.login({ claims: { sub: "waiting-user" } })).result,
      "admission_full",
    );
    await h.worker.scheduled({ scheduledTime: h.time() }, databases);
    expect(await count("accounts")).toBe(149);
    expect(await count("deletion_jobs")).toBe(0);
    for (const table of [
      "accounts",
      "identities",
      "workspaces",
      "operations",
      "sessions",
      "stage_summaries",
      "pending_archives",
      "self_percentiles",
    ]) {
      expect(
        (
          await databases.PERSONAL_DB.prepare(
            `SELECT count(*) AS n FROM ${table} WHERE user_id = ?`,
          )
            .bind(userId)
            .first<{ n: number }>()
        )?.n,
      ).toBe(0);
    }
    expect((await h.login({ claims: { sub: "waiting-user" } })).result.status).toBe(200);
    expect(await count("accounts")).toBe(150);
  });

  it("cron processes one oldest ready deletion per invocation and isolates a stuck first job", async () => {
    const h = await harness();
    h.alignLane(1);
    await databases.PUBLIC_AGGREGATE_DB.prepare("UPDATE privacy_fence SET generation = 1").run();
    for (let i = 0; i < 6; i++) {
      await databases.PERSONAL_DB.batch([
        databases.PERSONAL_DB.prepare(
          "INSERT INTO accounts (user_id, created_at, last_active_at, blocked) VALUES (?, ?, ?, 1)",
        ).bind(`job-${i}`, h.time(), h.time()),
        databases.PERSONAL_DB.prepare(
          "INSERT INTO deletion_jobs (user_id, op_id, created_at, fence_generation) VALUES (?, ?, ?, 1)",
        ).bind(`job-${i}`, `delete-job-${i}`, h.time() + i),
      ]);
    }
    const privacy = databases.PRIVACY_CONTROL_DB;
    const unavailable: PersonalEnv = {
      ...databases,
      PRIVACY_CONTROL_DB: {
        prepare(sql) {
          const statement = privacy.prepare(sql);
          return {
            bind(...values: (string | number | null)[]) {
              if (
                sql.startsWith("INSERT INTO privacy_operations") &&
                values[0] === "delete-job-0"
              ) {
                throw new Error("one_stuck_job");
              }
              return statement.bind(...values);
            },
            run: <T>() => statement.run<T>(),
            first: <T>() => statement.first<T>(),
          };
        },
        batch: (statements) => privacy.batch(statements),
        exec: (sql) => privacy.exec(sql),
      },
    };
    await h.worker.scheduled({ scheduledTime: h.time() }, unavailable);
    for (let i = 0; i < 4; i++) {
      await h.worker.scheduled({ scheduledTime: h.time() }, unavailable);
    }
    expect(await count("accounts")).toBe(2);
    expect(await count("deletion_jobs")).toBe(2);
    expect(
      (
        await databases.PERSONAL_DB.prepare(
          "SELECT retry_after FROM deletion_jobs WHERE user_id = 'job-0'",
        ).first<{ retry_after: number }>()
      )?.retry_after,
    ).toBeGreaterThan(h.time());
    expect(
      (
        await databases.PERSONAL_DB.prepare(
          "SELECT user_id FROM deletion_jobs WHERE user_id = 'job-5'",
        ).first<{ user_id: string }>()
      )?.user_id,
    ).toBe("job-5");
    await h.worker.scheduled({ scheduledTime: h.time() }, unavailable);
    expect(await count("accounts")).toBe(1);
    expect(await count("deletion_jobs")).toBe(1);
  });

  it("cron still completes privacy recovery when its expiry cleanup batch fails", async () => {
    const h = await harness();
    h.alignLane(1);
    const login = await h.login();
    const userId = h.accountId(login.cookie) ?? "";
    await databases.PUBLIC_AGGREGATE_DB.prepare("UPDATE privacy_fence SET generation = 1").run();
    await databases.PERSONAL_DB.batch([
      databases.PERSONAL_DB.prepare("UPDATE accounts SET blocked = 1 WHERE user_id = ?").bind(
        userId,
      ),
      databases.PERSONAL_DB.prepare(
        "INSERT INTO deletion_jobs (user_id, op_id, created_at, fence_generation) VALUES (?, 'cleanup-failure-delete', ?, 1)",
      ).bind(userId, h.time()),
      databases.PERSONAL_DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    ]);
    const personal = databases.PERSONAL_DB;
    let failCleanup = true;
    const unavailable: PersonalEnv = {
      ...databases,
      PERSONAL_DB: {
        prepare: (sql) => personal.prepare(sql),
        batch: (statements) => {
          if (failCleanup) {
            failCleanup = false;
            return Promise.reject(new Error("expiry_cleanup_failure_canary"));
          }
          return personal.batch(statements);
        },
        exec: (sql) => personal.exec(sql),
      },
    };
    await expect(h.worker.scheduled({ scheduledTime: h.time() }, unavailable)).rejects.toThrow(
      "maintenance_failed",
    );
    expect(await count("deletion_jobs")).toBe(0);
    expect(await count("accounts")).toBe(0);
    expect(await count("workspaces")).toBe(0);
    expect(
      await databases.PRIVACY_CONTROL_DB.prepare(
        "SELECT state FROM privacy_operations WHERE user_id = ?",
      )
        .bind(userId)
        .first<{ state: string }>(),
    ).toEqual({ state: "complete" });
  });

  it("cron resumes one stale consent reservation per invocation and leaves a live attempt leased", async () => {
    const h = await harness();
    h.alignLane(2);
    const hash = await sha256(JSON.stringify([0, true]));
    for (let i = 0; i < 7; i++) {
      await databases.PERSONAL_DB.prepare(
        "INSERT INTO accounts (user_id, created_at, last_active_at) VALUES (?, ?, ?)",
      )
        .bind(`consent-job-${i}`, h.time(), h.time())
        .run();
      await databases.PRIVACY_CONTROL_DB.prepare(
        `INSERT INTO consent_reservations
         (user_id, op_id, request_hash, base_revision, participation, write_nonce, created_at, attempt_nonce, busy_until)
         VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?)`,
      )
        .bind(
          `consent-job-${i}`,
          `op-${i}`,
          hash,
          `write-${i}`,
          h.time() + i,
          i === 6 ? "live-attempt" : null,
          i === 6 ? h.time() + 60_000 : 0,
        )
        .run();
    }
    for (let i = 0; i < 5; i++) {
      await h.worker.scheduled({ scheduledTime: h.time(), cron: "*/10 * * * *" }, databases);
    }
    expect(
      (
        await databases.PRIVACY_CONTROL_DB.prepare(
          "SELECT count(*) AS n FROM consent_decisions",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(5);
    expect(
      (
        await databases.PRIVACY_CONTROL_DB.prepare(
          "SELECT count(*) AS n FROM consent_reservations",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(2);
    const live = await databases.PRIVACY_CONTROL_DB.prepare(
      "SELECT attempt_nonce FROM consent_reservations WHERE user_id = 'consent-job-6'",
    ).first<{ attempt_nonce: string }>();
    expect(live?.attempt_nonce).toBe("live-attempt");
    await h.worker.scheduled({ scheduledTime: h.time(), cron: "*/10 * * * *" }, databases);
    expect(
      (
        await databases.PRIVACY_CONTROL_DB.prepare(
          "SELECT count(*) AS n FROM consent_decisions",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(6);
  });

  it("matching consent retries reuse the saved fence after a private commit failure", async () => {
    const h = await harness();
    const login = await h.login();
    const input = { opId: "resumable", baseDecisionVersion: 0, participation: true };
    const privacy = databases.PRIVACY_CONTROL_DB;
    const unavailable: PersonalEnv = {
      ...databases,
      PUBLICATION_ENABLED: "true",
      PRIVACY_CONTROL_DB: {
        prepare(sql) {
          if (sql.startsWith("INSERT INTO consent_decisions"))
            throw new Error("commit_unavailable");
          return privacy.prepare(sql);
        },
        batch: (statements) => privacy.batch(statements),
        exec: (sql) => privacy.exec(sql),
      },
    };
    const failed = await h.worker.fetch(
      new Request(`${TEST_ORIGIN}/v1/consent`, {
        method: "PUT",
        headers: {
          Origin: TEST_ORIGIN,
          Cookie: login.cookie,
          "Content-Type": "application/json",
          "If-Account-Match": `"${h.accountId(login.cookie)}"`,
        },
        body: JSON.stringify(input),
      }),
      unavailable,
    );
    expect(failed.status).toBe(503);
    expect(
      (
        await databases.PUBLIC_AGGREGATE_DB.prepare("SELECT generation FROM privacy_fence").first<{
          generation: number;
        }>()
      )?.generation,
    ).toBe(1);
    const collision = await h.mutate(
      "/v1/consent",
      { ...input, participation: false },
      login.cookie,
      "PUT",
    );
    expect(collision.status).toBe(409);
    expect(await collision.json()).toEqual({ error: "op_id_conflict" });
    expect((await h.mutate("/v1/consent", input, login.cookie, "PUT")).status).toBe(200);
    expect((await h.mutate("/v1/consent", input, login.cookie, "PUT")).status).toBe(200);
    expect(
      (
        await databases.PUBLIC_AGGREGATE_DB.prepare("SELECT generation FROM privacy_fence").first<{
          generation: number;
        }>()
      )?.generation,
    ).toBe(1);
    expect(
      (
        await databases.PRIVACY_CONTROL_DB.prepare(
          "SELECT decision_version FROM consent_decisions",
        ).first<{ decision_version: number }>()
      )?.decision_version,
    ).toBe(1);
  });

  it("callback removes a deleted account restored into PERSONAL before provisioning a fresh rejoin", async () => {
    const h = await harness();
    const old = await h.login();
    const oldId = h.accountId(old.cookie) ?? "";
    await h.mutate("/v1/account", { opId: "delete-before-restore" }, old.cookie, "DELETE");
    await databases.PERSONAL_DB.batch([
      databases.PERSONAL_DB.prepare(
        "INSERT INTO accounts (user_id, created_at, last_active_at) VALUES (?, ?, ?)",
      ).bind(oldId, h.time(), h.time()),
      databases.PERSONAL_DB.prepare(
        "INSERT INTO identities VALUES ('https://accounts.google.com', 'alice', ?)",
      ).bind(oldId),
      databases.PERSONAL_DB.prepare(
        'INSERT INTO workspaces (user_id, document) VALUES (?, \'{"schemaVersion":1,"items":["restored-old-data"],"lifetimeStages":[]}\')',
      ).bind(oldId),
    ]);
    const fresh = await h.login();
    expect(fresh.result.status).toBe(200);
    expect(h.accountId(fresh.cookie)).not.toBe(oldId);
    expect((await h.account(fresh.cookie)).status).toBe(200);
    expect(
      (
        await databases.PERSONAL_DB.prepare("SELECT count(*) AS n FROM accounts WHERE user_id = ?")
          .bind(oldId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    const workspace = await (
      await h.request("/v1/workspace", { headers: { Cookie: fresh.cookie } })
    ).json();
    expect(workspace).toMatchObject({ revision: 0, document: { items: [] } });
  });

  it("HTTP admission stays atomic at the 150-account cap and quota only blocks new archiving", async () => {
    const h = await harness();
    const login = await h.login();
    await databases.PERSONAL_DB.batch([
      databases.PERSONAL_DB.prepare(
        `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<149)
         INSERT INTO accounts (user_id, created_at, last_active_at)
         SELECT 'fixture-' || x, ?, ? FROM n`,
      ).bind(h.time(), h.time()),
      databases.PERSONAL_DB.prepare(
        `INSERT INTO identities SELECT 'https://accounts.google.com', user_id, user_id
         FROM accounts WHERE user_id LIKE 'fixture-%'`,
      ),
      databases.PERSONAL_DB.prepare(
        `INSERT INTO workspaces (user_id, document)
         SELECT user_id, '{"schemaVersion":1,"items":[],"lifetimeStages":[]}'
         FROM accounts WHERE user_id LIKE 'fixture-%'`,
      ),
    ]);
    expect(await count("accounts")).toBe(150);
    await accountError((await h.login({ claims: { sub: "over-cap" } })).result, "admission_full");
    expect((await h.login()).result.status).toBe(200); // Existing identity is not refused.
    expect(await count("accounts")).toBe(150);
    await databases.PERSONAL_DB.prepare("UPDATE accounts SET quota_bytes = 1").run();
    const summary = {
      itemId: "item",
      stage: "R",
      lifetimeAttempts: 1,
      lifetimeIncome: 1,
      preSignupIncome: 0,
      manualEntry: true,
      verified: false,
    };
    const input = {
      ...put("archive"),
      document: { schemaVersion: 1, items: [], lifetimeStages: [summary] },
      action: {
        kind: "archive",
        archive: {
          archiveId: "a1",
          summary,
          startedAt: h.time(),
          completedAt: h.time(),
        },
      },
    };
    expect((await h.mutate("/v1/workspace", input, login.cookie, "PUT")).status).toBe(422);
    expect(await count("operations")).toBe(0);
    expect((await h.mutate("/v1/workspace", put(), login.cookie, "PUT")).status).toBe(200);
    expect(await count("pending_archives")).toBe(0);
  });

  it("disabled statistics, ranks and consent writes return feature-unavailable without accessing any store", async () => {
    const h = await harness();
    const login = await h.login();
    const unavailable = () => {
      throw new Error("disabled_feature_must_not_access_storage");
    };
    const db = { prepare: unavailable, batch: unavailable, exec: unavailable };
    for (const flag of ["false", "", "TRUE"]) {
      for (const path of [
        "/v1/statistics",
        "/v1/self-percentile",
        "/v1/consent",
        "/api/personal/settings",
      ]) {
        for (const cookie of ["", login.cookie]) {
          const result = await h.worker.fetch(
            new Request(`${TEST_ORIGIN}${path}`, {
              method: path.includes("consent") || path.includes("settings") ? "PUT" : "GET",
              headers: { Cookie: cookie, Origin: TEST_ORIGIN },
              // No body/account context: disabled writes must not try to parse or authorize.
            }),
            {
              ...databases,
              PUBLICATION_ENABLED: flag,
              PERSONAL_DB: db,
              PRIVACY_CONTROL_DB: db,
              PUBLIC_AGGREGATE_DB: db,
            },
          );
          expect(result.status).toBe(404);
          expect(await result.json()).toEqual({ error: "feature_unavailable" });
          expect(result.headers.get("Cache-Control")).toBe("no-store");
        }
      }
    }
  });

  it("consent CAS has one winner but disabled public/self-percentile endpoints disclose no ranks", async () => {
    const h = await harness();
    const login = await h.login();
    const results = await Promise.all(
      ["c1", "c2"].map((opId) =>
        h.mutate(
          "/v1/consent",
          {
            opId,
            baseDecisionVersion: 0,
            participation: true,
          },
          login.cookie,
          "PUT",
        ),
      ),
    );
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(results.filter((result) => result.status === 409)).toHaveLength(1);
    expect(
      await (await h.request("/v1/consent", { headers: { Cookie: login.cookie } })).json(),
    ).toMatchObject({ participation: true, decisionVersion: 1 });
    expect(
      (
        await databases.PUBLIC_AGGREGATE_DB.prepare("SELECT generation FROM privacy_fence").first<{
          generation: number;
        }>()
      )?.generation,
    ).toBe(1);
    await databases.PERSONAL_DB.prepare(
      `INSERT INTO self_percentiles SELECT user_id, 'stale-release', 'R',
       '{"releaseId":"stale-release","stage":"R","percentileBand":{"lower":40,"upper":50},"manualEntry":true,"verified":false}'
       FROM accounts`,
    ).run();
    for (const path of ["/v1/statistics", "/v1/self-percentile"]) {
      const result = await h.request(path, { headers: { Cookie: login.cookie } });
      expect(result.status).toBe(404);
      expect(await result.json()).toEqual({ error: "feature_unavailable" });
    }
  });

  it("every mutation enforces Origin and Sec-Fetch-Site; rejects malformed/large bodies and ambiguous cookies", async () => {
    const h = await harness();
    const login = await h.login();
    for (const [path, method] of [
      ["/auth/login/google", "POST"],
      ["/auth/callback/google", "POST"],
      ["/auth/logout", "POST"],
      ["/api/auth/session", "DELETE"],
      ["/v1/account", "DELETE"],
      ["/v1/workspace", "PUT"],
      ["/v1/consent", "PUT"],
      ["/v1/sessions/revoke-all", "POST"],
    ] as const) {
      for (const headers of [
        { Origin: "https://evil.example" },
        { Origin: TEST_ORIGIN, "Sec-Fetch-Site": "cross-site" },
        { Origin: TEST_ORIGIN, "Sec-Fetch-Site": "same-site" },
        {},
      ]) {
        expect(
          (
            await h.request(path ?? "", {
              method,
              headers: { ...headers, Cookie: login.cookie, "Content-Type": "application/json" },
              body: "{}",
            })
          ).status,
        ).toBe(path === "/auth/callback/google" ? 303 : 403);
      }
    }
    const tooLarge = await h.request("/v1/workspace", {
      method: "PUT",
      headers: {
        Origin: TEST_ORIGIN,
        Cookie: login.cookie,
        "Content-Type": "application/json",
        "If-Account-Match": `"${h.accountId(login.cookie)}"`,
      },
      body: `"${"x".repeat(MAX_BODY_BYTES)}"`,
    });
    expect(tooLarge.status).toBe(413);
    expect(
      (
        await h.mutate(
          "/v1/workspace",
          { ...put(), document: { schemaVersion: 2 } },
          login.cookie,
          "PUT",
        )
      ).status,
    ).toBe(400);
    expect((await h.account(`${login.cookie}; ${login.cookie}`)).status).toBe(401);
    expect((await h.request("/auth/callback/github")).status).toBe(404);
    expect((await h.request("/auth/login/google")).status).toBe(405);
  });

  it("bounds pending TTL, cleans expired flows, and atomically enforces login rate limits", async () => {
    const h = await harness();
    const flow = await h.begin();
    h.advance(FLOW_TTL_MS);
    await accountError(
      await h.callback(h.issuer.authorize(flow.location), flow.cookie),
      "login_flow_expired",
    );
    const flows = await Promise.all(
      Array.from({ length: 11 }, () => h.mutate("/auth/login/google", {})),
    );
    expect(flows.filter((result) => result.status === 200)).toHaveLength(10);
    expect(flows.filter((result) => result.status === 429)).toHaveLength(1);
    expect(await count("oauth_transactions")).toBe(10);
    h.advance(FLOW_TTL_MS);
    await h.begin();
    expect(await count("oauth_transactions")).toBe(1);
    expect(FLOW_COOKIE).toBe("__Host-flow");
  });

  it("returns no-store and allowlisted errors without logging callback canaries", async () => {
    const h = await harness();
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const result = await h.mutate("/auth/callback/google", {
      parameters: "?state=CODE_CANARY&code=TOKEN_CANARY",
    });
    await accountError(result, "unknown");
    for (const path of [
      "/v1/account",
      "/v1/workspace",
      "/v1/export",
      "/v1/statistics",
      "/not-a-route",
    ]) {
      expect((await h.request(path)).headers.get("Cache-Control")).toBe("no-store");
    }
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("redirects every callback failure using only the app error vocabulary and no provider input", async () => {
    const h = await harness();
    const flow = await h.begin();
    const parameters = new URL(h.issuer.authorize(flow.location)).search;
    const cases = [
      [new HttpError(409, "account_switch_requires_logout"), "account_switch_requires_logout"],
      [new HttpError(401, "google_issuer_unsupported"), "google_issuer_unsupported"],
      [new HttpError(403, "beta_full"), "admission_full"],
      [new HttpError(429, "rate_limited"), "rate_limited"],
      [new HttpError(400, "login_flow_expired"), "login_flow_expired"],
      [new HttpError(503, "service_unavailable"), "service_unavailable"],
      [new HttpError(401, "auth_failed"), "unknown"],
      [new Error("PROVIDER_RAW_ERROR_CANARY"), "service_unavailable"],
    ] as const;
    for (const [failure, code] of cases) {
      const personal = databases.PERSONAL_DB;
      const unavailable: PersonalEnv = {
        ...databases,
        PERSONAL_DB: {
          prepare(sql) {
            if (sql.startsWith("DELETE FROM oauth_transactions")) throw failure;
            return personal.prepare(sql);
          },
          batch: (statements) => personal.batch(statements),
          exec: (sql) => personal.exec(sql),
        },
      };
      const result = await h.worker.fetch(
        new Request(`${TEST_ORIGIN}/auth/callback/google`, {
          method: "POST",
          headers: { Origin: TEST_ORIGIN, "Content-Type": "application/json", Cookie: flow.cookie },
          body: JSON.stringify({ parameters }),
        }),
        unavailable,
      );
      await accountError(result, code);
      expect(result.headers.get("Location")).not.toMatch(/CANARY|state|code=/);
      expect(
        result.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`)),
      ).toBe(false);
    }
    const denied = new URL(flow.location);
    const denial = `?state=${denied.searchParams.get("state")}&error=ACCESS_DENIED_CANARY&error_description=PROVIDER_CANARY`;
    await accountError(
      await h.mutate("/auth/callback/google", { parameters: denial }, flow.cookie),
      "unknown",
    );
    expect(h.issuer.counts.token).toBe(0);
    expect(await count("accounts")).toBe(0);
  });
});
