/** Seeds archived invocation rows for health/canary readers; never runs collection. */
export async function seedInvocation(
  db: D1Database,
  deploymentSha: string,
  scheduledTime: number,
  pollMode: string,
  prefix = "",
) {
  const id = `${prefix}${deploymentSha}:${scheduledTime}`;
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO collector_invocations (
         invocation_id, deployment_sha, scheduled_at, started_at, status, poll_mode
       ) VALUES (?, ?, ?, ?, 'running', ?)`,
    )
    .bind(
      id,
      deploymentSha,
      new Date(scheduledTime).toISOString(),
      new Date().toISOString(),
      pollMode,
    )
    .run();
  return result.meta.changes === 1 ? id : null;
}

export async function completeInvocation(
  db: D1Database,
  id: string,
  status: string,
  queuedCount: number,
  errorCode: string | null,
  nextRetryAt: string | null,
) {
  await db
    .prepare(
      `UPDATE collector_invocations
       SET status = ?, finished_at = ?, queued_count = ?, error_code = ?, next_retry_at = ?
       WHERE invocation_id = ? AND status = 'running'`,
    )
    .bind(status, new Date().toISOString(), queuedCount, errorCode, nextRetryAt, id)
    .run();
}
