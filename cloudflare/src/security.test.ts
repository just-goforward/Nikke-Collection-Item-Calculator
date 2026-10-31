import { createExecutionContext } from "cloudflare:test";
import { env as bindings } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trustedClientIp } from "./client-ip";
import type { WorkerEnv } from "./env";
import { emptyResponse, handleOptions, jsonResponse } from "./http";
import { handleStats } from "./stats-read";
import { verifyTurnstile } from "./turnstile";
import worker from "./worker";

afterEach(() => vi.unstubAllGlobals());

function workerEnv(overrides: Partial<WorkerEnv>): WorkerEnv {
  return { ...bindings, ...overrides };
}

describe("stats security", () => {
  const env = { ALLOWED_ORIGINS: "https://nikkecollection.com" };
  it.each(["?random=123", "?deployment-smoke=revision", "?"])(
    "rejects query %s before limiter or database access",
    async (query) => {
      const limit = vi.fn(async () => ({ success: true }));
      const prepare = vi.spyOn(bindings.DB, "prepare");
      const fetchHandler = worker.fetch;
      if (!fetchHandler) throw new Error("Missing fetch handler");
      const response = await fetchHandler(
        new Request(`https://test/api/stats${query}`) as Parameters<typeof fetchHandler>[0],
        workerEnv({ ...env, READ_RATE_LIMITER: { limit } }),
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "unexpected_query" });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(limit).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      prepare.mockRestore();
    },
  );
  it.each(["https://nikkecollection.com", "https://a,https://b"])(
    "rejects smoke preflight without caching for %s",
    (origins) => {
      const response = handleOptions(
        new Request("https://test/api/stats", {
          method: "OPTIONS",
          headers: {
            Origin: "https://worker-smoke.invalid",
            "Access-Control-Request-Method": "GET",
          },
        }),
        { ALLOWED_ORIGINS: origins },
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    },
  );
  it.each([200, 304])("fixes CORS for cacheable %s responses across ingress", (status) => {
    for (const host of ["service.internal", "stats.workers.dev"]) {
      const request = new Request(`https://${host}/api/stats`);
      const response = emptyResponse(request, env, status, "public, max-age=60");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(env.ALLOWED_ORIGINS);
      expect(response.headers.has("Vary")).toBe(false);
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    }
  });
  it("keeps staging, errors and POST uncacheable", () => {
    const request = new Request("https://stats.test/api/stats");
    expect(emptyResponse(request, env, 500, "public").headers.get("Cache-Control")).toBe(
      "no-store",
    );
    expect(
      emptyResponse(request, { ALLOWED_ORIGINS: "https://a,https://b" }, 200, "public").headers.get(
        "Cache-Control",
      ),
    ).toBe("no-store");
    expect(
      jsonResponse(new Request(request, { method: "POST" }), env, {}, 200, "public").headers.get(
        "Cache-Control",
      ),
    ).toBe("no-store");
  });
  it("ignores XFF and uses a shared missing-IP bucket", () => {
    expect(
      trustedClientIp(new Request("https://test", { headers: { "X-Forwarded-For": "spoof" } })),
    ).toBe("unknown");
    expect(
      trustedClientIp(
        new Request("https://test", {
          headers: { "CF-Connecting-IP": "192.0.2.1", "X-Forwarded-For": "spoof" },
        }),
      ),
    ).toBe("192.0.2.1");
  });
  it("rejects a miss with 429 no-store before database access", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const fetchHandler = worker.fetch;
    if (!fetchHandler) throw new Error("Missing fetch handler");
    const response = await fetchHandler(
      new Request("https://test/api/stats") as Parameters<typeof fetchHandler>[0],
      workerEnv({ ...env, READ_RATE_LIMITER: { limit } }),
      createExecutionContext(),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(limit).toHaveBeenCalledWith({ key: "unknown" });
  });
  it("keeps origin rejection on misses", async () => {
    await expect(
      handleStats(
        new Request("https://test/api/stats", { headers: { Origin: "https://evil" } }),
        workerEnv(env),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("Turnstile hostname", () => {
  it.each(["nikkecollection.com", "evil.example", undefined])("validates %s", async (hostname) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: true, action: "kit_result", hostname })),
    );
    const result = verifyTurnstile(
      new Request("https://test"),
      {
        TURNSTILE_SECRET_KEY: "secret",
        TURNSTILE_ALLOWED_HOSTNAMES: "nikkecollection.com",
      },
      "a".repeat(20),
      "kit_result",
    );
    if (hostname === "nikkecollection.com") await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toMatchObject({ status: 403 });
  });
  it("fails closed without hostname configuration", async () => {
    await expect(
      verifyTurnstile(
        new Request("https://test"),
        {
          TURNSTILE_SECRET_KEY: "secret",
        },
        "a".repeat(20),
        "kit_result",
      ),
    ).rejects.toMatchObject({ status: 500 });
  });
});
