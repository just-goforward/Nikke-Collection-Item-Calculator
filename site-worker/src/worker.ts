import { errorCode } from "../../shared/errorCodes";
import { createForecastEndpoint, type ForecastEnv } from "./forecast";
import { tokensMatch, validProbeSecret } from "./probe-auth";

const forecastEndpoint = createForecastEndpoint();
type FetchBinding = { fetch(request: Request): Promise<Response> };

export type SiteEnv = ForecastEnv & {
  ASSETS: FetchBinding;
  SITE_ENV?: string;
  STATS?: FetchBinding;
  STATS_HEALTH_PROBE_TOKEN?: string;
  STATS_HEALTH_RATE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
};

const STATS_METHODS: Record<string, readonly string[]> = {
  "/api/stats": ["GET"],
  "/api/events": ["POST"],
  "/api/decision-events": ["POST"],
};

function privateResponse(response: Response, noStore = false): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (noStore) headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorResponse(status: number, error: string): Response {
  return privateResponse(Response.json({ error }, { status }), true);
}

async function proxy(
  request: Request,
  binding: FetchBinding | undefined,
  noStore: boolean,
): Promise<Response> {
  if (!binding) return errorResponse(503, "service_not_configured");
  const headers = new Headers(request.headers);
  headers.delete("Cookie");
  headers.delete("Authorization");
  headers.delete("Proxy-Authorization");
  if (new URL(request.url).pathname === "/api/decision-events") headers.delete("Referer");
  try {
    const response = await binding.fetch(new Request(request, { headers, redirect: "manual" }));
    const forwarded = privateResponse(response, noStore);
    forwarded.headers.delete("Set-Cookie");
    return forwarded;
  } catch (error) {
    // Never log request headers, personal data, or upstream exception details: only the
    // registry's fixed category for the upstream binding call is recorded.
    console.warn(JSON.stringify({ event: "upstream_proxy_failed", code: errorCode(error) }));
    return errorResponse(502, "service_unavailable");
  }
}

export default {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/api/forecast" || path === "/api/forecast/version")
      return privateResponse(await forecastEndpoint(request, env), true);
    if (path === "/api/_ci/stats-health") {
      const authorization = request.headers.get("Authorization") ?? "";
      if (
        request.method !== "GET" ||
        !validProbeSecret(env.STATS_HEALTH_PROBE_TOKEN) ||
        !authorization.startsWith("Bearer ") ||
        !(await tokensMatch(authorization.slice(7), env.STATS_HEALTH_PROBE_TOKEN))
      ) {
        return errorResponse(404, "not_found");
      }
      if (!env.STATS_HEALTH_RATE_LIMITER) return errorResponse(503, "service_not_configured");
      try {
        const limit = await env.STATS_HEALTH_RATE_LIMITER.limit({
          key: "stats-health-production",
        });
        if (!limit.success) return errorResponse(429, "rate_limited");
      } catch {
        return errorResponse(503, "service_unavailable");
      }
      // Fixed authority and Accept only: never forward caller credentials, Origin or query.
      return proxy(
        new Request("https://nikkecollection.com/api/health", {
          headers: { Accept: "application/json" },
          redirect: "manual",
        }),
        env.STATS,
        true,
      );
    }
    if (path === "/robots.txt") {
      if (env.SITE_ENV === "production") {
        const response = await env.ASSETS.fetch(request);
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", "public, max-age=0, must-revalidate");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      return privateResponse(
        new Response(request.method === "HEAD" ? null : "User-agent: *\nDisallow: /\n", {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      );
    }
    const statsMethods = STATS_METHODS[path];
    if (statsMethods) {
      if (!statsMethods.includes(request.method)) return errorResponse(405, "method_not_allowed");
      return proxy(request, env.STATS, request.method !== "GET");
    }
    // No wildcard proxy, public diagnostic/health endpoints, or API-to-SPA fallback.
    if (/^\/(?:api|auth|account|admin|v1)(?:\/|$)/.test(path)) {
      return errorResponse(404, "not_found");
    }
    const response = await env.ASSETS.fetch(request);
    return env.SITE_ENV === "production" ? response : privateResponse(response);
  },
};
