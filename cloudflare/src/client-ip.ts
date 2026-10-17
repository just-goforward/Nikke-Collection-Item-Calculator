export function trustedClientIp(request: Request) {
  // Non-Cloudflare ingress shares one fail-safe bucket; never trust forwarded headers.
  return request.headers.get("CF-Connecting-IP") || "unknown";
}
