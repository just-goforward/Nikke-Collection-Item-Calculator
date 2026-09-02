type RateLimitEnv = {
  DB: D1Database;
};

export async function cleanupExpiredStatistics(env: RateLimitEnv, now: number): Promise<void> {
  await env.DB.prepare("DELETE FROM event_ids WHERE created_at < ?")
    .bind(now - 86400 * 14)
    .run();
}
