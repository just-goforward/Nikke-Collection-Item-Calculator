import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import worker, { type SiteEnv } from "../site-worker/src/worker";

const personalRoutes = [
  ["/auth/login/google", ["POST"]],
  ["/auth/callback/google", ["GET", "POST"]],
  ["/auth/logout", ["POST"]],
  ["/v1/account", ["GET", "DELETE"]],
  ["/v1/workspace", ["GET", "PUT"]],
  ["/v1/export", ["GET"]],
  ["/v1/consent", ["GET", "PUT"]],
  ["/v1/sessions/revoke-all", ["POST"]],
  ["/v1/statistics", ["GET"]],
  ["/v1/self-percentile", ["GET"]],
  ["/api/auth/session", ["GET", "DELETE"]],
  ["/api/auth/logout", ["POST"]],
  ["/api/personal/settings", ["GET", "PUT"]],
] as const;

function environment() {
  const ASSETS = { fetch: vi.fn(async (_request: Request) => new Response("asset")) };
  const STATS = {
    fetch: vi.fn(
      async (_request: Request) =>
        new Response("stats", { headers: { "Set-Cookie": "upstream=1" } }),
    ),
  };
  const PERSONAL_DATA = {
    fetch: vi.fn(
      async (_request: Request) =>
        new Response("personal", { headers: { "Set-Cookie": "session=1" } }),
    ),
  };
  return { ASSETS, STATS, PERSONAL_DATA };
}
const request = (path: string, init?: RequestInit) =>
  new Request(`https://staging.nikkecollection.com${path}`, init);

describe("staging site gateway: personal routing and callback security", () => {
  it.each(personalRoutes)("routes exactly the documented methods for %s", async (path, methods) => {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const env = environment();
      const writes = !["GET", "HEAD"].includes(method);
      const response = await worker.fetch(
        request(`${path}?fixture=1`, {
          method,
          headers: {
            Origin: "https://staging.nikkecollection.com",
            "Sec-Fetch-Site": "same-origin",
            Cookie: "session=1",
          },
          ...(writes ? { body: '{"fixture":1}' } : {}),
        }),
        env,
      );
      const allowed = (methods as readonly string[]).includes(method);
      expect(response.status).toBe(allowed ? 200 : 405);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(env.PERSONAL_DATA.fetch).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(env.STATS.fetch).not.toHaveBeenCalled();
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
      if (allowed) {
        const forwarded = env.PERSONAL_DATA.fetch.mock.calls[0]?.[0];
        expect(forwarded?.url).toBe(`https://staging.nikkecollection.com${path}?fixture=1`);
        expect(forwarded?.method).toBe(method);
        expect(forwarded?.redirect).toBe("manual");
        expect(forwarded?.headers.get("Origin")).toBe("https://staging.nikkecollection.com");
        expect(forwarded?.headers.get("Sec-Fetch-Site")).toBe("same-origin");
        if (writes) expect(await forwarded?.text()).toBe('{"fixture":1}');
      }
    }
  });

  it("keeps the public release cookie-free on the personal binding", async () => {
    const env = environment();
    const response = await worker.fetch(
      request("/v1/statistics", {
        headers: {
          Cookie: "session=1",
          Authorization: "Bearer private",
          "Proxy-Authorization": "private",
        },
      }),
      env,
    );
    const forwarded = env.PERSONAL_DATA.fetch.mock.calls[0]?.[0];
    for (const header of ["Cookie", "Authorization", "Proxy-Authorization"])
      expect(forwarded?.headers.has(header)).toBe(false);
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(env.STATS.fetch).not.toHaveBeenCalled();
  });

  it("preserves the callback bridge body and upstream CSP without applying the asset policy", async () => {
    const env = environment();
    const html = '<script nonce="upstream">fetch("/auth/callback/google",{method:"POST"})</script>';
    const csp =
      "default-src 'none'; script-src 'nonce-upstream'; connect-src 'self'; frame-ancestors 'none'";
    env.PERSONAL_DATA.fetch.mockResolvedValueOnce(
      new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": csp,
          "Cache-Control": "public, max-age=3600",
        },
      }),
    );
    const response = await worker.fetch(
      request("/auth/callback/google?code=fixture&state=fixture", {
        headers: { "Sec-Fetch-Site": "cross-site", Cookie: "flow=fixture" },
      }),
      env,
    );
    expect(await response.text()).toBe(html);
    expect(response.headers.get("Content-Security-Policy")).toBe(csp);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(env.PERSONAL_DATA.fetch.mock.calls[0]?.[0]?.headers.get("Cookie")).toBe("flow=fixture");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { Origin: "https://other.invalid" },
    { Origin: "null" },
    { Origin: "https://staging.nikkecollection.com", "Sec-Fetch-Site": "same-site" },
    { Origin: "https://staging.nikkecollection.com", "Sec-Fetch-Site": "cross-site" },
  ])("rejects callback POST outside the same-origin bridge: %j", async (headers) => {
    const env = environment();
    const response = await worker.fetch(
      request("/auth/callback/google", {
        method: "POST",
        headers,
        body: '{"parameters":"?code=fixture"}',
      }),
      env,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(env.PERSONAL_DATA.fetch).not.toHaveBeenCalled();
  });

  it("accepts callback POST with exact Origin when Sec-Fetch-Site is absent", async () => {
    const env = environment();
    expect(
      (
        await worker.fetch(
          request("/auth/callback/google", {
            method: "POST",
            headers: { Origin: "https://staging.nikkecollection.com" },
            body: '{"parameters":"?code=fixture"}',
          }),
          env,
        )
      ).status,
    ).toBe(200);
  });
});

describe("staging site gateway: account flow", () => {
  it("completes login, callback bridge, session and workspace GET/PUT through a fake binding", async () => {
    const env = environment();
    const origin = "https://staging.nikkecollection.com";
    const parameters = "?code=fake-code&state=fake-state";
    const bridge =
      '<script nonce="fixture">fetch("/auth/callback/google",{method:"POST"})</script>';
    const csp = "default-src 'none'; script-src 'nonce-fixture'; connect-src 'self'";
    const PERSONAL_DATA = {
      fetch: vi.fn(async (input: Request) => {
        const path = new URL(input.url).pathname;
        if (path === "/auth/login/google") {
          expect(input.method).toBe("POST");
          expect(await input.json()).toEqual({});
          return Response.json(
            { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fake-state" },
            {
              headers: { "Set-Cookie": "flow=fake-flow; Secure; HttpOnly; SameSite=Lax; Path=/" },
            },
          );
        }
        if (path === "/auth/callback/google" && input.method === "GET") {
          expect(new URL(input.url).search).toBe(parameters);
          expect(input.headers.get("Cookie")).toBe("flow=fake-flow");
          return new Response(bridge, {
            headers: { "Content-Type": "text/html", "Content-Security-Policy": csp },
          });
        }
        if (path === "/auth/callback/google") {
          expect(input.method).toBe("POST");
          expect(input.headers.get("Origin")).toBe(origin);
          expect(input.headers.get("Sec-Fetch-Site")).toBe("same-origin");
          expect(input.headers.get("Cookie")).toBe("flow=fake-flow");
          expect(await input.json()).toEqual({ parameters });
          return Response.json(
            { redirect: "/" },
            {
              headers: {
                "Set-Cookie": "session=fake-session; Secure; HttpOnly; SameSite=Lax; Path=/",
              },
            },
          );
        }
        expect(path).toBe("/v1/workspace");
        expect(input.headers.get("Cookie")).toBe("session=fake-session");
        if (input.method === "PUT") {
          expect(await input.json()).toEqual({
            opId: "fixture-save",
            baseRevision: 0,
            document: { items: [] },
            action: "save",
          });
          return Response.json({ status: "saved", revision: 1 });
        }
        expect(input.method).toBe("GET");
        return Response.json({ revision: 0, document: { items: [] } });
      }),
    };
    const gatewayEnv = { ...env, PERSONAL_DATA };
    const postHeaders = {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    };
    const login = await worker.fetch(
      request("/auth/login/google", {
        method: "POST",
        headers: postHeaders,
        body: "{}",
      }),
      gatewayEnv,
    );
    expect(await login.json()).toEqual({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fake-state",
    });
    const flowCookie = login.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    const getBridge = await worker.fetch(
      request(`/auth/callback/google${parameters}`, {
        headers: { Cookie: flowCookie, "Sec-Fetch-Site": "cross-site" },
      }),
      gatewayEnv,
    );
    expect(await getBridge.text()).toBe(bridge);
    expect(getBridge.headers.get("Content-Security-Policy")).toBe(csp);
    expect(getBridge.headers.get("Referrer-Policy")).toBe("no-referrer");
    const complete = await worker.fetch(
      request("/auth/callback/google", {
        method: "POST",
        headers: { ...postHeaders, Cookie: flowCookie },
        body: JSON.stringify({ parameters }),
      }),
      gatewayEnv,
    );
    expect(await complete.json()).toEqual({ redirect: "/" });
    const sessionCookie = complete.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    expect(sessionCookie).toBe("session=fake-session");
    const workspace = await worker.fetch(
      request("/v1/workspace", { headers: { Cookie: sessionCookie } }),
      gatewayEnv,
    );
    expect(await workspace.json()).toEqual({ revision: 0, document: { items: [] } });
    const saved = await worker.fetch(
      request("/v1/workspace", {
        method: "PUT",
        headers: { ...postHeaders, Cookie: sessionCookie },
        body: JSON.stringify({
          opId: "fixture-save",
          baseRevision: 0,
          document: { items: [] },
          action: "save",
        }),
      }),
      gatewayEnv,
    );
    expect(await saved.json()).toEqual({ status: "saved", revision: 1 });
    for (const response of [login, getBridge, complete, workspace, saved])
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(PERSONAL_DATA.fetch).toHaveBeenCalledTimes(5);
    expect(env.STATS.fetch).not.toHaveBeenCalled();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });
});

describe("staging site gateway: binding isolation and assets", () => {
  it("fails closed for all personal routes without a binding and for upstream failures", async () => {
    const env = environment();
    for (const [path, methods] of personalRoutes) {
      const response = await worker.fetch(
        request(path, {
          method: methods[0],
          headers: { Origin: "https://staging.nikkecollection.com" },
        }),
        { ASSETS: env.ASSETS },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    env.PERSONAL_DATA.fetch.mockRejectedValueOnce(new Error("private callback exception"));
    const response = await worker.fetch(request("/auth/callback/google"), env);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('{"error":"service_unavailable"}');
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("runs the gateway first for v1 routes in local and staging asset config", async () => {
    const config = await readFile(new URL("../site-worker/wrangler.toml", import.meta.url), "utf8");
    const rules = [...config.matchAll(/^run_worker_first = (.+)$/gm)];
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(JSON.parse(rule[1] ?? "[]")).toEqual(
        expect.arrayContaining(["/v1", "/v1/*", "/auth", "/auth/*"]),
      );
    }
  });

  it("strips credentials towards stats and cookies from its response", async () => {
    const env = environment();
    const response = await worker.fetch(
      request("/api/stats?date=2026-10-13", {
        headers: {
          Cookie: "private=1",
          Authorization: "Bearer private",
          "Proxy-Authorization": "private",
        },
      }),
      env,
    );
    const forwarded = env.STATS.fetch.mock.calls[0]?.[0] as Request | undefined;
    expect(forwarded?.url).toBe("https://staging.nikkecollection.com/api/stats?date=2026-10-13");
    expect(forwarded?.headers.has("Cookie")).toBe(false);
    expect(forwarded?.headers.has("Authorization")).toBe(false);
    expect(forwarded?.headers.has("Proxy-Authorization")).toBe(false);
    expect(forwarded?.redirect).toBe("manual");
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("forwards event bodies without credentials and never caches writes", async () => {
    const env = environment();
    const response = await worker.fetch(
      request("/api/events", {
        method: "POST",
        body: '{"event":"fixture"}',
        headers: { Cookie: "private=1" },
      }),
      env,
    );
    const forwarded = env.STATS.fetch.mock.calls[0]?.[0] as Request | undefined;
    expect(await forwarded?.text()).toBe('{"event":"fixture"}');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("preserves personal session credentials and Set-Cookie but forbids caching", async () => {
    const env = environment();
    const response = await worker.fetch(
      request("/api/auth/session", {
        headers: { Cookie: "session=1", Authorization: "Bearer session" },
      }),
      env,
    );
    const forwarded = env.PERSONAL_DATA.fetch.mock.calls[0]?.[0] as Request | undefined;
    expect(forwarded?.headers.get("Cookie")).toBe("session=1");
    expect(forwarded?.headers.get("Authorization")).toBe("Bearer session");
    expect(response.headers.get("Set-Cookie")).toBe("session=1");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(env.STATS.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "/api/admin/solver-diagnostics",
    "/api/health",
    "/api/unknown",
    "/admin",
    "/auth/callback",
    "/account/profile",
    "/v1/unknown",
    "/v1/admin/solver-diagnostics",
    "/v1/workspace/other-account",
    "/auth/callback/google/extra",
    "/auth/login/apple",
    "/v1/health",
  ])("blocks unallowlisted endpoint %s rather than serving HTML", async (path) => {
    const env = environment();
    const response = await worker.fetch(request(path), env);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    expect(env.STATS.fetch).not.toHaveBeenCalled();
    expect(env.PERSONAL_DATA.fetch).not.toHaveBeenCalled();
  });

  it("rejects methods, fails closed without bindings, and sanitizes failures", async () => {
    const env = environment();
    expect((await worker.fetch(request("/api/stats", { method: "POST" }), env)).status).toBe(405);
    const unbound: SiteEnv = { ASSETS: env.ASSETS };
    expect((await worker.fetch(request("/api/personal/settings"), unbound)).status).toBe(503);
    env.STATS.fetch.mockRejectedValueOnce(new Error("sensitive exception"));
    const response = await worker.fetch(request("/api/stats"), env);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("sensitive");
  });

  it("serves staging robots and preserves asset CSP", async () => {
    const env = environment();
    const robots = await worker.fetch(request("/robots.txt"), env);
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
    env.ASSETS.fetch.mockResolvedValueOnce(
      new Response("html", {
        headers: { "Content-Security-Policy": "frame-ancestors 'none'" },
      }),
    );
    const response = await worker.fetch(request("/en/"), env);
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("sends unknown non-API paths only to static assets", async () => {
    const env = environment();
    const input = request("/unknown-page?fixture=1");
    expect(await (await worker.fetch(input, env)).text()).toBe("asset");
    expect(env.ASSETS.fetch).toHaveBeenCalledWith(input);
    expect(env.STATS.fetch).not.toHaveBeenCalled();
    expect(env.PERSONAL_DATA.fetch).not.toHaveBeenCalled();
  });
});
