export type OpsEnvironment = "staging" | "production";
export type OpsSeverity = "warning" | "critical";

export async function upsertOpsAlert(
  db: D1Database,
  input: Parameters<typeof upsertOpsAlertStatement>[1],
) {
  await upsertOpsAlertStatement(db, input).run();
}

export function upsertOpsAlertStatement(
  db: D1Database,
  input: {
    alertKey: string;
    environment: OpsEnvironment;
    severity: OpsSeverity;
    component: string;
    errorCode: string;
    context?: Record<string, string | number | boolean | null>;
    notifyAfterCount?: number;
    nowMs?: number;
    guard?: { sql: string; bindings: (string | number | null)[] };
  },
) {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const nextSendAt = now;
  return db
    .prepare(
      `INSERT INTO forecast_ops_alerts (
         alert_key, environment, severity, component, error_code, state, context_json,
         notify_after_count, occurrence_count, first_seen_at, last_seen_at, next_send_at
       ) ${
         input.guard
           ? `SELECT ?, ?, ?, ?, ?, 'open', ?, ?, 1, ?, ?, ? WHERE ${input.guard.sql}`
           : "VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 1, ?, ?, ?)"
       }
       ON CONFLICT(alert_key) DO UPDATE SET
         environment = excluded.environment,
         severity = excluded.severity,
         component = excluded.component,
         error_code = excluded.error_code,
         state = 'open',
         context_json = excluded.context_json,
         notify_after_count = excluded.notify_after_count,
         occurrence_count = CASE
           WHEN forecast_ops_alerts.state = 'open' THEN forecast_ops_alerts.occurrence_count + 1
           ELSE 1
         END,
         first_seen_at = CASE
           WHEN forecast_ops_alerts.state = 'open' THEN forecast_ops_alerts.first_seen_at
           WHEN excluded.first_seen_at <= forecast_ops_alerts.first_seen_at
             THEN strftime('%Y-%m-%dT%H:%M:%fZ', forecast_ops_alerts.first_seen_at, '+0.001 seconds')
           ELSE excluded.first_seen_at
         END,
         last_sent_at = CASE
           WHEN forecast_ops_alerts.state = 'open' THEN forecast_ops_alerts.last_sent_at
           ELSE NULL
         END,
         last_sent_occurrence_count = CASE
           WHEN forecast_ops_alerts.state = 'open' THEN forecast_ops_alerts.last_sent_occurrence_count
           ELSE 0
         END,
         discord_message_id = CASE
           WHEN forecast_ops_alerts.state = 'open' THEN forecast_ops_alerts.discord_message_id
           ELSE NULL
         END,
         last_seen_at = excluded.last_seen_at,
         next_send_at = CASE
           WHEN forecast_ops_alerts.state = 'resolved' THEN excluded.next_send_at
           ELSE forecast_ops_alerts.next_send_at
         END,
         resolved_at = NULL,
         recovery_sent_at = NULL,
         last_send_error = NULL`,
    )
    .bind(
      bounded(input.alertKey, 160),
      input.environment,
      input.severity,
      bounded(input.component, 48),
      errorCode(input.errorCode),
      contextJson(input.context),
      Math.max(1, Math.trunc(input.notifyAfterCount ?? 1)),
      now,
      now,
      nextSendAt,
      ...(input.guard?.bindings ?? []),
    );
}

export async function resolveOpsAlertsByPrefix(
  db: D1Database,
  alertKeyPrefix: string,
  nowMs = Date.now(),
) {
  const now = new Date(nowMs).toISOString();
  await db
    .prepare(
      `UPDATE forecast_ops_alerts
       SET state = 'resolved', resolved_at = ?, next_send_at = ?
       WHERE alert_key LIKE ? ESCAPE '\\' AND state = 'open'`,
    )
    .bind(now, now, `${likeLiteral(bounded(alertKeyPrefix, 150))}%`)
    .run();
}

export async function readOperationsHealth(db: D1Database, environment: OpsEnvironment) {
  const [dispatcher, actionable, oldest, latestDispatch, alerts] = await Promise.all([
    db
      .prepare(
        `SELECT status, COALESCE(finished_at, started_at) AS observed_at, deployment_sha, error_code
         FROM dispatcher_invocations WHERE environment = ? ORDER BY scheduled_at DESC LIMIT 1`,
      )
      .bind(environment)
      .first<{
        status: string;
        observed_at: string;
        deployment_sha: string;
        error_code: string | null;
      }>(),
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM source_queue WHERE status = 'pending') AS pending_count,
           (SELECT COUNT(*) FROM forecast_candidates
             WHERE state IN ('crosschecked', 'x_unavailable')) AS candidate_count`,
      )
      .first<{ pending_count: number; candidate_count: number }>(),
    db
      .prepare("SELECT MIN(first_seen_at) AS oldest_at FROM source_queue WHERE status = 'pending'")
      .first<{ oldest_at: string | null }>(),
    db
      .prepare(
        `SELECT dispatch_id, state, accepted_at, error_code
         FROM workflow_dispatches WHERE environment = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(environment)
      .first<{
        dispatch_id: string;
        state: string;
        accepted_at: string | null;
        error_code: string | null;
      }>(),
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open_count,
           SUM(CASE WHEN state = 'open' AND occurrence_count > last_sent_occurrence_count THEN 1 ELSE 0 END) AS unsent_count,
           SUM(CASE WHEN state = 'open' AND severity = 'critical'
                          AND occurrence_count > last_sent_occurrence_count THEN 1 ELSE 0 END) AS unsent_critical_count
         FROM forecast_ops_alerts WHERE environment = ?`,
      )
      .bind(environment)
      .first<{
        open_count: number | null;
        unsent_count: number | null;
        unsent_critical_count: number | null;
      }>(),
  ]);
  return {
    dispatcher: dispatcher
      ? {
          status: dispatcher.status,
          lastObservedAt: dispatcher.observed_at,
          deploymentSha: dispatcher.deployment_sha,
          errorCode: dispatcher.error_code,
        }
      : { status: "missing", lastObservedAt: null, deploymentSha: null, errorCode: null },
    actionableWork: {
      pending: Number(actionable?.pending_count ?? 0),
      candidates: Number(actionable?.candidate_count ?? 0),
      oldestPendingAt: oldest?.oldest_at ?? null,
    },
    latestDispatch: latestDispatch
      ? {
          dispatchId: latestDispatch.dispatch_id,
          state: latestDispatch.state,
          acceptedAt: latestDispatch.accepted_at,
          errorCode: latestDispatch.error_code,
        }
      : null,
    alerts: {
      open: Number(alerts?.open_count ?? 0),
      unsent: Number(alerts?.unsent_count ?? 0),
      unsentCritical: Number(alerts?.unsent_critical_count ?? 0),
    },
  };
}

export function sanitizeOpsError(error: unknown) {
  const value = error instanceof Error ? error.message : "unknown";
  return errorCode(value);
}

function contextJson(value: Record<string, string | number | boolean | null> | undefined) {
  const json = JSON.stringify(value ?? {});
  return json.length <= 2_000 ? json : '{"truncated":true}';
}

function bounded(value: string, max: number) {
  const cleaned = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? "_" : character;
  })
    .join("")
    .slice(0, max);
  if (!cleaned) throw new Error("empty_ops_value");
  return cleaned;
}

function likeLiteral(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function errorCode(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "unknown";
}
