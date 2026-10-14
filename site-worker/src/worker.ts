type FetchBinding = { fetch(request: Request): Promise<Response> };

export type SiteEnv = {
  ASSETS: FetchBinding;
  STATS?: FetchBinding;
  PERSONAL_DATA?: FetchBinding;
};

const STATS_METHODS: Record<string, readonly string[]> = {
  "/api/stats": ["GET"],
  "/api/events": ["POST"],
};

// Reserved contract placeholders. No personal Worker is provisioned or bound yet.
const PERSONAL_METHODS: Record<string, readonly string[]> = {
  "/api/auth/session": ["GET", "DELETE"],
  "/api/auth/logout": ["POST"],
  "/api/personal/settings": ["GET", "PUT"],
};

function stagingResponse(response: Response, noStore = false): Response {
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
  return stagingResponse(Response.json({ error }, { status }), true);
}

async function proxy(
  request: Request,
  binding: FetchBinding | undefined,
  personal: boolean,
): Promise<Response> {
  if (!binding) return errorResponse(503, "service_not_configured");
  const headers = new Headers(request.headers);
  if (!personal) {
    headers.delete("Cookie");
    headers.delete("Authorization");
    headers.delete("Proxy-Authorization");
  }
  try {
    const response = await binding.fetch(new Request(request, { headers, redirect: "manual" }));
    const forwarded = stagingResponse(response, personal || request.method !== "GET");
    if (!personal) forwarded.headers.delete("Set-Cookie");
    return forwarded;
  } catch {
    // Never log request headers, personal data, or upstream exception details.
    return errorResponse(502, "service_unavailable");
  }
}

export default {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/robots.txt") {
      return stagingResponse(
        new Response("User-agent: *\nDisallow: /\n", {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      );
    }
    const statsMethods = STATS_METHODS[path];
    if (statsMethods) {
      if (!statsMethods.includes(request.method)) return errorResponse(405, "method_not_allowed");
      return proxy(request, env.STATS, false);
    }
    const personalMethods = PERSONAL_METHODS[path];
    if (personalMethods) {
      if (!personalMethods.includes(request.method))
        return errorResponse(405, "method_not_allowed");
      return proxy(request, env.PERSONAL_DATA, true);
    }
    // No wildcard proxy, diagnostic/health endpoints, or API-to-SPA fallback.
    if (/^\/(?:api|auth|account|admin)(?:\/|$)/.test(path)) {
      return errorResponse(404, "not_found");
    }
    return stagingResponse(await env.ASSETS.fetch(request));
  },
};
