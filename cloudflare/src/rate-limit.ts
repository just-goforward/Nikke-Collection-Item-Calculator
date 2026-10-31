type RateLimitEnv = {
  DB: D1Database;
};

export async function cleanupExpiredStatistics(env: RateLimitEnv, now: number): Promise<void> {
  const cutoff = now - 86400 * 14;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM event_ids WHERE created_at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM stats_rejection_event_ids WHERE created_at < ?").bind(cutoff),
  ]);
}
