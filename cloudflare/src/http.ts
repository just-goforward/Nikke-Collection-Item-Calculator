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
  if (!isAllowedOrigin(request, env)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

export function jsonResponse(
  request: Request,
  env: CorsEnv,
  body: unknown,
  status = 200,
  cacheControl = "no-store",
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...securityHeaders(cacheControl), ...corsHeaders(request, env) },
  });
}
