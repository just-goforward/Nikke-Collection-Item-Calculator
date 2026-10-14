import type { D1Migration } from "@cloudflare/vitest-plugin";
import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FLOW_COOKIE, FLOW_TTL_MS, SESSION_COOKIE, SESSION_IDLE_MS, SESSION_MAX_MS, sha256 } from "./auth";
import { fakeIssuer, TEST_CLIENT, TEST_ORIGIN, TEST_SECRET } from "./fake-issuer";
import { MAX_BODY_BYTES } from "./http";
import { googleProvider } from "./google";
import { createWorker } from "./worker";
import type { PersonalEnv } from "./types";

const bindings = env as unknown as PersonalEnv & {
  PERSONAL_MIGRATIONS: D1Migration[];
  PRIVACY_MIGRATIONS: D1Migration[];
  PUBLIC_MIGRATIONS: D1Migration[];
};
const databases: PersonalEnv = {
  ...bindings, SITE_ORIGIN: TEST_ORIGIN, GOOGLE_CLIENT_ID: TEST_CLIENT, GOOGLE_CLIENT_SECRET: TEST_SECRET,
};
const put = (opId = "op1", baseRevision = 0) => ({
  opId, baseRevision, document: { schemaVersion: 1, items: ["personal"], lifetimeStages: [] },
  action: { kind: "save" },
});
function cookieHeader(result: Response): string {
  return result.headers.getSetCookie().map((value) => value.split(";")[0])
    .filter((value) => value && !value.endsWith("=")).join("; ");
}
async function count(table: string): Promise<number> {
  const result = await databases.PERSONAL_DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return result?.n ?? -1;
}
async function harness() {
  const issuer = await fakeIssuer();
  let time = Date.now();
  const worker = createWorker(issuer.fetch, () => time);
  const request = (path: string, init: RequestInit = {}) => worker.fetch(
    new Request(path.startsWith("https:") ? path : `${TEST_ORIGIN}${path}`, init), databases,
  );
  const mutate = (path: string, value: unknown, session = "", method = "POST") => request(path, {
    method, headers: { Origin: TEST_ORIGIN, "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json", Cookie: session }, body: JSON.stringify(value),
  });
  const begin = async () => {
    const result = await mutate("/auth/login/google", {});
    expect(result.status).toBe(200);
    const payload = await result.json() as { authorizationUrl: string };
    return { location: payload.authorizationUrl, cookie: cookieHeader(result), result };
  };
  const callback = async (url: string, cookie: string) => mutate(
    "/auth/callback/google", { parameters: new URL(url).search }, cookie,
  );
  const login = async (options: Parameters<typeof issuer.authorize>[1] = {}) => {
    const flow = await begin();
    const url = issuer.authorize(flow.location, options);
    const result = await callback(url, flow.cookie);
    return { flow, url, result, cookie: cookieHeader(result) };
  };
  const account = (cookie: string) => request("/api/auth/session", { headers: { Cookie: cookie } });
  return {
    issuer, worker, request, mutate, begin, callback, login, account,
    advance(milliseconds: number) { time += milliseconds; },
    time: () => time,
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  for (const [db, migrations] of [
    [databases.PERSONAL_DB, bindings.PERSONAL_MIGRATIONS],
    [databases.PRIVACY_CONTROL_DB, bindings.PRIVACY_MIGRATIONS],
    [databases.PUBLIC_AGGREGATE_DB, bindings.PUBLIC_MIGRATIONS],
  ] as const) {
    for (const migration of migrations) await db.batch(migration.queries.map((sql) => db.prepare(sql)));
  }
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
    expect(authorization.searchParams.get("redirect_uri")).toBe(`${TEST_ORIGIN}/auth/callback/google`);
    expect(authorization.searchParams.get("scope")).toBe("openid");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("nonce")).toBeTruthy();
    const url = h.issuer.authorize(flow.location);
    const get = await h.request(url, { headers: { Cookie: flow.cookie, "Sec-Fetch-Site": "cross-site" } });
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
    const flags = login.result.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`));
    expect(flags).toMatch(/Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000/);
    expect(flags).not.toContain("Domain=");
    const raw = login.cookie.split("=")[1] ?? "";
    expect(raw).toMatch(/^[a-f0-9]{64}$/);
    const row = await databases.PERSONAL_DB.prepare("SELECT token_hash FROM sessions").first<{ token_hash: string }>();
    expect(row?.token_hash).toBe(await sha256(raw));
    expect(row?.token_hash).not.toBe(raw);
    expect(await count("accounts")).toBe(1);
    expect(await count("workspaces")).toBe(1);
    const tables = await databases.PERSONAL_DB.batch([
      databases.PERSONAL_DB.prepare("SELECT * FROM accounts"),
      databases.PERSONAL_DB.prepare("SELECT * FROM identities"),
      databases.PERSONAL_DB.prepare("SELECT * FROM sessions"),
    ]);
    expect(JSON.stringify(tables)).not.toMatch(/ACCESS_TOKEN_CANARY|REFRESH_TOKEN_CANARY|email|id_token/);
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
    const results = await Promise.all(Array.from({ length: 20 }, () => h.callback(url, flow.cookie)));
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(h.issuer.counts.token).toBe(1);
    expect(await count("oauth_transactions")).toBe(0);
    expect((await h.callback(url, flow.cookie)).status).toBe(400);
    const failed = await h.login({ failExchange: true });
    expect(failed.result.status).toBe(401);
    const previous = h.issuer.counts.token;
    expect((await h.callback(failed.url, failed.flow.cookie)).status).toBe(400);
    expect(h.issuer.counts.token).toBe(previous);
  });

  it("rejects invalid signature, missing iss/aud/exp, issuer, audience, nonce, azp and PKCE", async () => {
    const h = await harness();
    for (const options of [
      { badSignature: true }, { missing: ["iss"] }, { missing: ["aud"] }, { missing: ["exp"] },
      { claims: { iss: "https://evil.example" } }, { claims: { aud: "other-client" } },
      { claims: { nonce: "wrong" } }, { claims: { azp: "unexpected-party" } },
      { claims: { aud: [TEST_CLIENT, "other"], azp: "unexpected-party" } },
      { challenge: "wrong-pkce" },
    ]) {
      // Distinct trusted ingress addresses isolate the separate login-rate policy.
      h.advance(60_000);
      const login = await h.login(options);
      expect(login.result.status).toBe(401);
      expect((await h.callback(login.url, login.flow.cookie)).status).toBe(400);
    }
    expect(await count("accounts")).toBe(0);
    expect(await count("sessions")).toBe(0);
  });

  it("accepts only canonical Google issuer; bare accounts.google.com is rejected, never a second identity", async () => {
    const h = await harness();
    expect((await h.login()).result.status).toBe(200);
    expect((await h.login({ claims: { iss: "accounts.google.com" } })).result.status).toBe(401);
    expect((await h.login()).result.status).toBe(200);
    expect(await count("identities")).toBe(1);
  });

  it("applies the explicit 30-second JWT tolerance but never tolerates session deadlines", async () => {
    const h = await harness();
    const seconds = Math.floor(Date.now() / 1_000);
    expect((await h.login({ claims: { exp: seconds - 20 } })).result.status).toBe(200);
    expect((await h.login({ claims: { exp: seconds - 40 } })).result.status).toBe(401);
    const valid = await h.login();
    h.advance(1);
    await databases.PERSONAL_DB.prepare("UPDATE sessions SET idle_expires_at = ?").bind(h.time()).run();
    expect((await h.account(valid.cookie)).status).toBe(401);
  });

  it("shares configuration/JWKS for concurrent cold starts in one isolate and separate isolates fail safely", async () => {
    const h = await harness();
    const flows = await Promise.all(Array.from({ length: 8 }, () => h.begin()));
    expect(h.issuer.counts.discovery).toBe(1);
    const results = await Promise.all(flows.map((flow) =>
      h.callback(h.issuer.authorize(flow.location), flow.cookie)));
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(h.issuer.counts.jwks).toBe(1);
    expect(await count("accounts")).toBe(1);
    expect(await count("sessions")).toBe(8);
    h.advance(60_000);
    // Independent worker factories represent independent caches; no shared credentials/cache storage.
    const second = createWorker(h.issuer.fetch, h.time);
    const third = createWorker(h.issuer.fetch, h.time);
    await Promise.all([second, third].map((worker) => worker.fetch(new Request(`${TEST_ORIGIN}/auth/login/google`, {
      method: "POST", headers: { Origin: TEST_ORIGIN, "Content-Type": "application/json" }, body: "{}",
    }), databases)));
    expect(h.issuer.counts.discovery).toBe(3);
  });

  it("unknown kid fails closed during cooldown; rotation succeeds after the library refresh interval", async () => {
    const h = await harness();
    expect((await h.login()).result.status).toBe(200);
    h.issuer.rotate();
    expect((await h.login()).result.status).toBe(401);
    expect(h.issuer.counts.jwks).toBe(1);
    const time = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(time + 61_000);
    expect((await h.login()).result.status).toBe(200);
    expect(h.issuer.counts.jwks).toBe(2);
    expect((await h.login({ kid: "unpublished-key" })).result.status).toBe(401);
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
    expect(login.result.status).toBe(401);
    expect((await h.callback(login.url, login.flow.cookie)).status).toBe(400);
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
  it("workspace CAS/replay, export, consent and existing site aliases all derive ownership from session", async () => {
    const h = await harness();
    const alice = await h.login();
    const bob = await h.login({ claims: { sub: "bob" } });
    const unauthenticated = await h.request("/v1/workspace");
    expect(unauthenticated.status).toBe(401);
    const consent = await h.request("/api/personal/settings", { headers: { Cookie: alice.cookie } });
    expect(await consent.json()).toEqual({ participation: null, decisionVersion: 0 });
    const saved = await h.mutate("/v1/workspace", put(), alice.cookie, "PUT");
    expect(await saved.json()).toEqual({ status: "saved", revision: 1, replayed: false });
    expect((await h.mutate("/v1/workspace", put(), alice.cookie, "PUT")).status).toBe(200);
    expect((await h.mutate("/v1/workspace", put("stale"), alice.cookie, "PUT")).status).toBe(409);
    expect((await h.mutate("/v1/workspace", { ...put(), userId: "bob" }, alice.cookie, "PUT")).status).toBe(400);
    const bobWorkspace = await h.request("/v1/workspace", { headers: { Cookie: bob.cookie } });
    expect((await bobWorkspace.json() as { revision: number }).revision).toBe(0);
    const exported = await h.request("/v1/export", { headers: { Cookie: alice.cookie } });
    expect(await exported.json()).toMatchObject({
      schemaVersion: 1, workspace: { revision: 1, document: { items: ["personal"] } },
      pendingArchives: [], stages: [], selfPercentiles: [],
    });
    const input = { opId: "optin", baseDecisionVersion: 0, participation: true };
    expect(await (await h.mutate("/api/personal/settings", input, alice.cookie, "PUT")).json())
      .toEqual({ participation: true, decisionVersion: 1 });
    expect((await h.mutate("/v1/consent", input, alice.cookie, "PUT")).status).toBe(200);
    expect((await h.mutate("/v1/consent", { ...input, participation: false }, alice.cookie, "PUT")).status).toBe(409);
    expect((await h.mutate("/v1/consent", {
      opId: "withdraw", baseDecisionVersion: 1, participation: false,
    }, alice.cookie, "PUT")).status).toBe(200);
    expect((await h.request("/v1/workspace", { headers: { Cookie: alice.cookie } })).status).toBe(200);
    expect((await h.mutate("/v1/consent", {
      opId: "reoptin", baseDecisionVersion: 2, participation: true,
    }, alice.cookie, "PUT")).status).toBe(200);
    expect(await count("accounts")).toBe(2);
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
    expect((await databases.PERSONAL_DB.prepare("SELECT idle_expires_at FROM sessions")
      .first<{ idle_expires_at: number }>())?.idle_expires_at).toBe(original?.idle_expires_at);
    const saved = await h.mutate("/v1/workspace", put(), login.cookie, "PUT");
    expect(saved.headers.get("Set-Cookie")).toContain("Max-Age=2592000");
    h.advance(29 * 86_400_000);
    await h.mutate("/v1/workspace", put("next", 1), login.cookie, "PUT");
    h.advance(29 * 86_400_000);
    const near = await h.mutate("/v1/workspace", put("near", 2), login.cookie, "PUT");
    expect(near.headers.get("Set-Cookie")).toContain("Max-Age=259200");
    expect((await databases.PERSONAL_DB.prepare("SELECT max_expires_at FROM sessions")
      .first<{ max_expires_at: number }>())?.max_expires_at).toBe(original?.max_expires_at);
    h.advance(3 * 86_400_000);
    expect((await h.account(login.cookie)).status).toBe(401);
    expect(SESSION_MAX_MS).toBe(90 * 86_400_000);
    expect(SESSION_IDLE_MS).toBe(30 * 86_400_000);
  });

  it("revoke-all rejects a callback paused before session creation, including an anonymous pre-revocation flow", async () => {
    const h = await harness();
    const current = await h.login();
    const pending = await h.begin();
    const url = h.issuer.authorize(pending.location);
    const gate = h.issuer.pauseNextExchange();
    const callback = h.callback(url, pending.cookie);
    await gate.entered;
    expect(await count("oauth_transactions")).toBe(0);
    expect((await h.mutate("/v1/sessions/revoke-all", { opId: "revoke" }, current.cookie)).status).toBe(200);
    gate.release();
    expect((await callback).status).toBe(401);
    expect(await count("sessions")).toBe(0);
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
    expect((await h.mutate("/v1/sessions/revoke-all", { opId: "all" }, second.cookie)).status).toBe(200);
    expect((await h.account(second.cookie)).status).toBe(401);
    expect((await h.account(third.cookie)).status).toBe(401);
    expect(await count("accounts")).toBe(1);
  });

  it("deletion blocks an in-flight callback and subsequent login, but withdrawal keeps personal data", async () => {
    const h = await harness();
    const current = await h.login();
    await h.mutate("/v1/workspace", put(), current.cookie, "PUT");
    const pending = await h.begin();
    const gate = h.issuer.pauseNextExchange();
    const callback = h.callback(h.issuer.authorize(pending.location), pending.cookie);
    await gate.entered;
    expect((await h.mutate("/v1/account", { opId: "delete" }, current.cookie, "DELETE")).status).toBe(202);
    gate.release();
    expect((await callback).status).toBe(401);
    expect(await count("accounts")).toBe(0);
    expect((await h.login()).result.status).toBe(401);
    expect(await count("accounts")).toBe(0);
    expect(await count("blocked_identities")).toBe(1);
  });

  it("a deletion privacy-write failure keeps the public fence and durable deny/outbox until retry", async () => {
    const h = await harness();
    const login = await h.login();
    const privacy = databases.PRIVACY_CONTROL_DB;
    const unavailable: PersonalEnv = {
      ...databases,
      PRIVACY_CONTROL_DB: {
        prepare(sql) {
          if (sql.includes("INSERT INTO privacy_operations")) throw new Error("RAW_EXCEPTION_CANARY");
          return privacy.prepare(sql);
        },
        batch: (statements) => privacy.batch(statements),
        exec: (sql) => privacy.exec(sql),
      },
    };
    const result = await h.worker.fetch(new Request(`${TEST_ORIGIN}/v1/account`, {
      method: "DELETE", headers: { Origin: TEST_ORIGIN, Cookie: login.cookie,
        "Content-Type": "application/json" }, body: JSON.stringify({ opId: "delete-failure" }),
    }), unavailable);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "service_unavailable" });
    expect(await count("sessions")).toBe(0);
    expect(await count("deletion_jobs")).toBe(1);
    expect((await databases.PUBLIC_AGGREGATE_DB.prepare("SELECT blocked FROM privacy_fence")
      .first<{ blocked: number }>())?.blocked).toBe(1);
    expect((await h.request("/v1/statistics")).status).toBe(503);
    expect(await count("accounts")).toBe(0);
    expect(await count("deletion_jobs")).toBe(0);
    expect((await h.account(login.cookie)).status).toBe(401);
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
    expect((await h.login({ claims: { sub: "over-cap" } })).result.status).toBe(403);
    expect((await h.login()).result.status).toBe(200); // Existing identity is not refused.
    expect(await count("accounts")).toBe(150);
    await databases.PERSONAL_DB.prepare("UPDATE accounts SET quota_bytes = 1").run();
    const summary = {
      itemId: "item", stage: "R", lifetimeAttempts: 1, lifetimeIncome: 1,
      preSignupIncome: 0, manualEntry: true, verified: false,
    };
    const input = {
      ...put("archive"),
      document: { schemaVersion: 1, items: [], lifetimeStages: [summary] },
      action: { kind: "archive", archive: {
        archiveId: "a1", summary, startedAt: h.time(), completedAt: h.time(),
      } },
    };
    expect((await h.mutate("/v1/workspace", input, login.cookie, "PUT")).status).toBe(422);
    expect(await count("operations")).toBe(0);
    expect((await h.mutate("/v1/workspace", put(), login.cookie, "PUT")).status).toBe(200);
    expect(await count("pending_archives")).toBe(0);
  });

  it("consent CAS has one winner and fenced public/self-percentile endpoints disclose no ranks", async () => {
    const h = await harness();
    const login = await h.login();
    const results = await Promise.all(["c1", "c2"].map((opId) => h.mutate("/v1/consent", {
      opId, baseDecisionVersion: 0, participation: true,
    }, login.cookie, "PUT")));
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(results.filter((result) => result.status === 409)).toHaveLength(1);
    await databases.PERSONAL_DB.prepare(
      `INSERT INTO self_percentiles SELECT user_id, 'stale-release', 'R',
       '{"releaseId":"stale-release","stage":"R","percentileBand":{"lower":40,"upper":50},"manualEntry":true,"verified":false}'
       FROM accounts`,
    ).run();
    expect(await (await h.request("/v1/self-percentile", { headers: { Cookie: login.cookie } })).json())
      .toEqual({ results: [] });
    expect((await h.request("/v1/statistics")).status).toBe(503);
  });

  it("every mutation enforces Origin and Sec-Fetch-Site; rejects malformed/large bodies and ambiguous cookies", async () => {
    const h = await harness();
    const login = await h.login();
    for (const [path, method] of [
      ["/auth/login/google", "POST"], ["/auth/callback/google", "POST"],
      ["/auth/logout", "POST"], ["/api/auth/session", "DELETE"],
      ["/v1/account", "DELETE"], ["/v1/workspace", "PUT"], ["/v1/consent", "PUT"],
      ["/v1/sessions/revoke-all", "POST"],
    ] as const) {
      for (const headers of [
        { Origin: "https://evil.example" }, { Origin: TEST_ORIGIN, "Sec-Fetch-Site": "cross-site" },
        { Origin: TEST_ORIGIN, "Sec-Fetch-Site": "same-site" }, {},
      ]) {
        expect((await h.request(path ?? "", {
          method, headers: { ...headers, Cookie: login.cookie, "Content-Type": "application/json" }, body: "{}",
        })).status).toBe(403);
      }
    }
    const tooLarge = await h.request("/v1/workspace", {
      method: "PUT", headers: { Origin: TEST_ORIGIN, Cookie: login.cookie, "Content-Type": "application/json" },
      body: `"${"x".repeat(MAX_BODY_BYTES)}"`,
    });
    expect(tooLarge.status).toBe(413);
    expect((await h.mutate("/v1/workspace", { ...put(), document: { schemaVersion: 2 } }, login.cookie, "PUT")).status).toBe(400);
    expect((await h.account(`${login.cookie}; ${login.cookie}`)).status).toBe(401);
    expect((await h.request("/auth/callback/github")).status).toBe(404);
    expect((await h.request("/auth/login/google")).status).toBe(405);
  });

  it("bounds pending TTL, cleans expired flows, and atomically enforces login rate limits", async () => {
    const h = await harness();
    const flow = await h.begin();
    h.advance(FLOW_TTL_MS);
    expect((await h.callback(h.issuer.authorize(flow.location), flow.cookie)).status).toBe(400);
    const flows = await Promise.all(Array.from({ length: 11 }, () => h.mutate("/auth/login/google", {})));
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
    const result = await h.mutate("/auth/callback/google",
      { parameters: "?state=CODE_CANARY&code=TOKEN_CANARY" });
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: "auth_failed" });
    for (const path of ["/v1/account", "/v1/workspace", "/v1/export", "/v1/statistics", "/not-a-route"]) {
      expect((await h.request(path)).headers.get("Cache-Control")).toBe("no-store");
    }
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
