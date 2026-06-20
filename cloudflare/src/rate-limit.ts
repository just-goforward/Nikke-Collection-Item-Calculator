import { HttpError } from "./http-error";

type RateLimitEnv = {
  DB: D1Database;
  RATE_LIMIT_SECRET?: string;
};

export async function rateLimit(
  request: Request,
  env: RateLimitEnv,
  scope: "pre" | "post",
  minuteLimit: number,
  dayLimit: number,
  now: number,
) {
  const ip =
    request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  const key = await hashKey(`${env.RATE_LIMIT_SECRET}:${ip}`);
  const minute = Math.floor(now / 60);
  const day = Math.floor(now / 86400);
  const counters = [
    { key: `${scope}:m:${key}:${minute}`, limit: minuteLimit, expiresAt: now + 180 },
    { key: `${scope}:d:${key}:${day}`, limit: dayLimit, expiresAt: now + 86400 * 2 },
  ];
  const statements = counters.map((counter) =>
    env.DB.prepare(
      `INSERT INTO rate_limits (key, count, expires_at)
       VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = count + 1, expires_at = ?
       RETURNING count`,
    ).bind(counter.key, counter.expiresAt, counter.expiresAt),
  );
  const results = await env.DB.batch(statements);
  results.forEach((result: D1Result<unknown>, index: number) => {
    const counter = counters[index];
    if (!counter) throw new HttpError(503, "rate_limit_unavailable", true);
    const row = result.results?.[0] as { count?: number } | undefined;
    if (Number(row?.count) > counter.limit) throw new HttpError(429, "rate_limited");
  });
}

export async function cleanupExpiredStatistics(env: RateLimitEnv, now: number): Promise<void> {
  await Promise.all([
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(now).run(),
    env.DB.prepare("DELETE FROM event_ids WHERE created_at < ?")
      .bind(now - 86400 * 14)
      .run(),
  ]);
}

async function hashKey(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
