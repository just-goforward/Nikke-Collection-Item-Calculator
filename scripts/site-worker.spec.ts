import { describe, expect, it, vi } from "vitest";
import worker, { type SiteEnv } from "../site-worker/src/worker";

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

describe("staging site gateway", () => {
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
});
