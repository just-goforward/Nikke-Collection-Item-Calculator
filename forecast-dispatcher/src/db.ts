import type { DispatcherEnvironment, OpsAlertRow } from "./types";

const ALERT_SUPPRESSION_MS = 30 * 60 * 1_000;

export async function raiseOpsAlert(
  db: D1Database,
  input: {
    alertKey: string;
    environment: DispatcherEnvironment;
    severity: "warning" | "critical";
    component: string;
    errorCode: string;
    context?: Record<string, string | number | boolean | null>;
    notifyAfterCount?: number;
    nowMs: number;
  },
) {
  const now = new Date(input.nowMs).toISOString();
  await db
    .prepare(
      `INSERT INTO forecast_ops_alerts (
         alert_key, environment, severity, component, error_code, state, context_json,
         notify_after_count, occurrence_count, first_seen_at, last_seen_at, next_send_at
       ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 1, ?, ?, ?)
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
      sanitizeErrorCode(input.errorCode),
      contextJson(input.context),
      Math.max(1, Math.trunc(input.notifyAfterCount ?? 1)),
      now,
      now,
      now,
    )
    .run();
}

export async function resolveOpsAlert(db: D1Database, alertKey: string, nowMs: number) {
  const now = new Date(nowMs).toISOString();
  await db
    .prepare(
      `UPDATE forecast_ops_alerts SET state = 'resolved', resolved_at = ?, next_send_at = ?
       WHERE alert_key = ? AND state = 'open'`,
    )
    .bind(now, now, bounded(alertKey, 160))
    .run();
}

export async function listDueAlerts(
  db: D1Database,
  environment: DispatcherEnvironment,
  nowMs: number,
  limit = 5,
): Promise<OpsAlertRow[]> {
  const now = new Date(nowMs).toISOString();
  const result = await db
    .prepare(
      `SELECT alert_key, environment, severity, component, error_code, state, context_json,
              occurrence_count, last_sent_occurrence_count, first_seen_at, resolved_at
       FROM forecast_ops_alerts
       WHERE environment = ? AND (
         (state = 'open' AND occurrence_count >= notify_after_count
          AND occurrence_count > last_sent_occurrence_count
          AND (next_send_at IS NULL OR next_send_at <= ?))
         OR
         (state = 'resolved' AND last_sent_at IS NOT NULL AND recovery_sent_at IS NULL
          AND (next_send_at IS NULL OR next_send_at <= ?))
       )
       ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, first_seen_at
       LIMIT ?`,
    )
    .bind(environment, now, now, Math.max(1, Math.min(20, Math.trunc(limit))))
    .all<{
      alert_key: string;
      environment: DispatcherEnvironment;
      severity: "warning" | "critical";
      component: string;
      error_code: string;
      state: "open" | "resolved";
      context_json: string;
      occurrence_count: number;
      last_sent_occurrence_count: number;
      first_seen_at: string;
      resolved_at: string | null;
    }>();
  return result.results.map((row) => ({
    alertKey: row.alert_key,
    environment: row.environment,
    severity: row.severity,
    component: row.component,
    errorCode: row.error_code,
    state: row.state,
    context: parseContext(row.context_json),
    occurrenceCount: Number(row.occurrence_count),
    lastSentOccurrenceCount: Number(row.last_sent_occurrence_count),
    firstSeenAt: row.first_seen_at,
    resolvedAt: row.resolved_at,
  }));
}

export async function markAlertSent(
  db: D1Database,
  alert: OpsAlertRow,
  messageId: string,
  nowMs: number,
) {
  const now = new Date(nowMs).toISOString();
  if (alert.state === "resolved") {
    await db
      .prepare(
        `UPDATE forecast_ops_alerts SET recovery_sent_at = ?, discord_message_id = ?, last_send_error = NULL
         WHERE alert_key = ? AND first_seen_at = ? AND state = 'resolved'
           AND resolved_at = ? AND recovery_sent_at IS NULL`,
      )
      .bind(now, messageId, alert.alertKey, alert.firstSeenAt, alert.resolvedAt)
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE forecast_ops_alerts
       SET last_sent_at = ?, last_sent_occurrence_count = ?,
           next_send_at = ?, discord_message_id = ?, last_send_error = NULL
       WHERE alert_key = ? AND first_seen_at = ? AND state = 'open'
         AND occurrence_count >= ? AND last_sent_occurrence_count < ?`,
    )
    .bind(
      now,
      alert.occurrenceCount,
      new Date(nowMs + ALERT_SUPPRESSION_MS).toISOString(),
      messageId,
      alert.alertKey,
      alert.firstSeenAt,
      alert.occurrenceCount,
      alert.occurrenceCount,
    )
    .run();
}

export async function markAlertSendFailed(
  db: D1Database,
  alert: OpsAlertRow,
  errorCode: string,
  nowMs: number,
  retryAfterMs = 5 * 60 * 1_000,
) {
  await db
    .prepare(
      `UPDATE forecast_ops_alerts SET last_send_error = ?, next_send_at = ?
       WHERE alert_key = ? AND first_seen_at = ? AND state = ?
         AND last_sent_occurrence_count = ? AND (
           (state = 'open' AND occurrence_count >= ? AND last_sent_occurrence_count < ?)
           OR
           (state = 'resolved' AND resolved_at = ? AND recovery_sent_at IS NULL)
         )`,
    )
    .bind(
      sanitizeErrorCode(errorCode),
      new Date(nowMs + Math.min(Math.max(retryAfterMs, 250), 60 * 60 * 1_000)).toISOString(),
      alert.alertKey,
      alert.firstSeenAt,
      alert.state,
      alert.lastSentOccurrenceCount,
      alert.occurrenceCount,
      alert.occurrenceCount,
      alert.resolvedAt,
    )
    .run();
}

function contextJson(value: Record<string, string | number | boolean | null> | undefined) {
  const json = JSON.stringify(value ?? {});
  return json.length <= 2_000 ? json : '{"truncated":true}';
}

function parseContext(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(
            (entry): entry is [string, string | number | boolean | null] =>
              ["string", "number", "boolean"].includes(typeof entry[1]) || entry[1] === null,
          )
          .slice(0, 12),
      );
    }
  } catch {
    // Invalid legacy context is represented without exposing its body.
  }
  return { invalidContext: true };
}

function bounded(value: string, max: number) {
  const cleaned = replaceControlCharacters(value, "_").slice(0, max);
  if (!cleaned) throw new Error("empty_ops_value");
  return cleaned;
}

function replaceControlCharacters(value: string, replacement: string) {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? replacement : character;
  }).join("");
}

function sanitizeErrorCode(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "unknown";
}
