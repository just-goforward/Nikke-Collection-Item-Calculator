type CorsEnv = {
  ALLOWED_ORIGINS?: string;
};

function normalizeOrigin(origin: unknown) {
  return String(origin || "")
    .trim()
    .replace(/\/+$/, "");
}

function allowedOrigins(env: CorsEnv) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
}

export function isAllowedOrigin(request: Request, env: CorsEnv) {
  const origin = normalizeOrigin(request.headers.get("Origin"));
  const allowed = allowedOrigins(env);
  if (!origin) return true;
  return allowed.includes(origin);
}

function corsHeaders(request: Request, env: CorsEnv): Record<string, string> {
  const origin = request.headers.get("Origin");
  const normalizedOrigin = normalizeOrigin(origin);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (normalizedOrigin && isAllowedOrigin(request, env)) {
    headers["Access-Control-Allow-Origin"] = normalizedOrigin;
  }
  return headers;
}

function securityHeaders(cacheControl = "no-store"): Record<string, string> {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": cacheControl,
  };
}

export function handleOptions(request: Request, env: CorsEnv) {
  return emptyResponse(request, env, isAllowedOrigin(request, env) ? 204 : 403);
}

function responseHeaders(
  request: Request,
  env: CorsEnv,
  status: number,
  cacheControl: string,
  extraHeaders: Record<string, string>,
) {
  const cors = corsHeaders(request, env);
  const origins = allowedOrigins(env);
  const stats = request.method === "GET" && new URL(request.url).pathname === "/api/stats";
  if (stats && (status === 200 || status === 304) && origins.length === 1) {
    cors["Access-Control-Allow-Origin"] = origins[0] ?? "";
    delete cors["Vary"];
  } else {
    // Multi-origin staging keeps reflected CORS, but never shares cached responses.
    cacheControl = "no-store";
  }
  return { ...securityHeaders(cacheControl), ...extraHeaders, ...cors };
}

export function emptyResponse(
  request: Request,
  env: CorsEnv,
  status: number,
  cacheControl = "no-store",
  extraHeaders: Record<string, string> = {},
) {
  return new Response(null, {
    status,
    headers: responseHeaders(request, env, status, cacheControl, extraHeaders),
  });
}

export function jsonResponse(
  request: Request,
  env: CorsEnv,
  body: unknown,
  status = 200,
  cacheControl = "no-store",
  extraHeaders: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(request, env, status, cacheControl, extraHeaders),
  });
}
