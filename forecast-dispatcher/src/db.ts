import { sha256Hex } from "./crypto";
import type {
  ActionableWork,
  DispatcherEnvironment,
  DispatchReservation,
  OpsAlertRow,
  WorkLink,
} from "./types";

const RESERVATION_LEASE_MS = 5 * 60 * 1_000;
const RECENT_DISPATCH_MS = 20 * 60 * 1_000;
const ALERT_SUPPRESSION_MS = 30 * 60 * 1_000;
const MAX_WORK_IDS = 1_000;

export async function startDispatcherInvocation(
  db: D1Database,
  input: {
    environment: DispatcherEnvironment;
    deploymentSha: string;
    scheduledTime: number;
  },
) {
  const scheduledAt = new Date(input.scheduledTime).toISOString();
  const invocationId = `${input.environment}:${input.deploymentSha}:${input.scheduledTime}`;
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO dispatcher_invocations (
         invocation_id, deployment_sha, environment, scheduled_at, started_at, status
       ) VALUES (?, ?, ?, ?, ?, 'running')`,
    )
    .bind(
      invocationId,
      input.deploymentSha,
      input.environment,
      scheduledAt,
      new Date().toISOString(),
    )
    .run();
  return Number(inserted.meta.changes ?? 0) === 1 ? invocationId : null;
}

export async function finishDispatcherInvocation(
  db: D1Database,
  invocationId: string,
  input: {
    status: "completed" | "failure";
    actionableCount: number;
    dispatchId?: string;
    errorCode?: string;
  },
) {
  await db
    .prepare(
      `UPDATE dispatcher_invocations
       SET status = ?, finished_at = ?, actionable_count = ?, dispatch_id = ?, error_code = ?
       WHERE invocation_id = ? AND status = 'running'`,
    )
    .bind(
      input.status,
      new Date().toISOString(),
      Math.max(0, Math.trunc(input.actionableCount)),
      input.dispatchId ?? null,
      input.errorCode ? sanitizeErrorCode(input.errorCode) : null,
      invocationId,
    )
    .run();
}

export async function readActionableWork(
  db: D1Database,
  environment: DispatcherEnvironment,
): Promise<ActionableWork> {
  const pending = await db
    .prepare(
      `SELECT source, item_id, title, url
       FROM source_queue WHERE status = 'pending'
       ORDER BY published_at, source, item_id LIMIT ?`,
    )
    .bind(MAX_WORK_IDS + 1)
    .all<{ source: WorkLink["source"]; item_id: string; title: string; url: string }>();
  const candidates = await db
    .prepare(
      `SELECT candidate_id FROM forecast_candidates
       WHERE state IN ('crosschecked', 'x_unavailable')
       ORDER BY created_at, candidate_id LIMIT ?`,
    )
    .bind(MAX_WORK_IDS + 1)
    .all<{ candidate_id: string }>();
  if (pending.results.length > MAX_WORK_IDS || candidates.results.length > MAX_WORK_IDS) {
    throw new Error("actionable_work_overflow");
  }
  const pendingIds = pending.results.map((row) => `${row.source}:${row.item_id}`).sort();
  const candidateIds = candidates.results.map((row) => row.candidate_id).sort();
  const fingerprint = await sha256Hex(
    JSON.stringify({ environment, pending: pendingIds, candidates: candidateIds }),
  );
  return {
    pendingIds,
    candidateIds,
    links: pending.results.slice(0, 3).map((row) => ({
      source: row.source,
      itemId: row.item_id,
      title: row.title,
      url: row.url,
    })),
    pendingCount: pendingIds.length,
    candidateCount: candidateIds.length,
    fingerprint,
  };
}

export async function reserveNextDispatch(
  db: D1Database,
  input: {
    environment: DispatcherEnvironment;
    invocationId: string;
    deploymentSha: string;
    work: ActionableWork;
    nowMs: number;
  },
): Promise<DispatchReservation | null> {
  const smoke = await reservePendingSmoke(db, input);
  if (smoke) return smoke;
  if (input.work.pendingCount + input.work.candidateCount === 0) return null;

  const now = new Date(input.nowMs).toISOString();
  const recentCutoff = new Date(input.nowMs - RECENT_DISPATCH_MS).toISOString();
  const recent = await db
    .prepare(
      `SELECT state, created_at, accepted_at, lease_until, next_attempt_at
       FROM workflow_dispatches
       WHERE environment = ? AND dispatch_mode = 'work' AND work_fingerprint = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(input.environment, input.work.fingerprint)
    .first<{
      state: string;
      created_at: string;
      accepted_at: string | null;
      lease_until: string | null;
      next_attempt_at: string | null;
    }>();
  if (
    recent &&
    ((["accepted", "running"].includes(recent.state) &&
      (recent.accepted_at ?? recent.created_at) >= recentCutoff) ||
      (recent.state === "reserved" && recent.lease_until !== null && recent.lease_until >= now) ||
      (recent.state === "failed" &&
        recent.next_attempt_at !== null &&
        recent.next_attempt_at > now))
  ) {
    return null;
  }

  const attemptRow = await db
    .prepare(
      `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM workflow_dispatches
       WHERE environment = ? AND dispatch_mode = 'work' AND work_fingerprint = ?`,
    )
    .bind(input.environment, input.work.fingerprint)
    .first<{ attempt: number }>();
  const attempt = Math.max(1, Number(attemptRow?.attempt ?? 1));
  const slot = Math.floor(input.nowMs / (3 * 60 * 1_000));
  const slotKey = `work:${input.environment}:${input.work.fingerprint}:${slot}`;
  const dispatchId = `fd-${(await sha256Hex(slotKey)).slice(0, 32)}`;
  const leaseUntil = new Date(input.nowMs + RESERVATION_LEASE_MS).toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO workflow_dispatches (
         dispatch_id, slot_key, environment, dispatch_mode, work_fingerprint,
         pending_count, candidate_count, attempt, state, reserved_by_invocation,
         dispatcher_deployment_sha, created_at, lease_until, next_attempt_at
       ) VALUES (?, ?, ?, 'work', ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?)`,
    )
    .bind(
      dispatchId,
      slotKey,
      input.environment,
      input.work.fingerprint,
      input.work.pendingCount,
      input.work.candidateCount,
      attempt,
      input.invocationId,
      input.deploymentSha,
      now,
      leaseUntil,
      now,
    )
    .run();
  await db
    .prepare(
      `UPDATE workflow_dispatches
       SET reserved_by_invocation = ?, dispatcher_deployment_sha = ?, lease_until = ?,
           attempt = attempt + 1, error_code = NULL
       WHERE dispatch_id = ? AND state = 'reserved' AND lease_until < ?`,
    )
    .bind(input.invocationId, input.deploymentSha, leaseUntil, dispatchId, now)
    .run();
  const owner = await db
    .prepare(
      `SELECT attempt FROM workflow_dispatches
       WHERE dispatch_id = ? AND state = 'reserved' AND reserved_by_invocation = ?`,
    )
    .bind(dispatchId, input.invocationId)
    .first<{ attempt: number }>();
  if (!owner) return null;
  return {
    dispatchId,
    mode: "work",
    fingerprint: input.work.fingerprint,
    pendingCount: input.work.pendingCount,
    candidateCount: input.work.candidateCount,
    attempt: Number(owner.attempt),
    links: input.work.links,
  };
}

export async function markDispatchRequested(
  db: D1Database,
  dispatchId: string,
  invocationId: string,
  nowMs: number,
) {
  const result = await db
    .prepare(
      `UPDATE workflow_dispatches SET requested_at = COALESCE(requested_at, ?)
       WHERE dispatch_id = ? AND state = 'reserved' AND reserved_by_invocation = ?`,
    )
    .bind(new Date(nowMs).toISOString(), dispatchId, invocationId)
    .run();
  if (Number(result.meta.changes ?? 0) !== 1) throw new Error("dispatch_reservation_lost");
}

export async function markDispatchAccepted(
  db: D1Database,
  dispatchId: string,
  invocationId: string,
  nowMs: number,
) {
  const now = new Date(nowMs).toISOString();
  const result = await db
    .prepare(
      `UPDATE workflow_dispatches
       SET state = CASE
             WHEN state IN ('running', 'succeeded', 'failed', 'cancelled') THEN state
             ELSE 'accepted'
           END,
           accepted_at = COALESCE(accepted_at, ?), github_http_status = 204,
           lease_until = NULL, next_attempt_at = NULL,
           error_code = CASE
             WHEN state IN ('succeeded', 'failed', 'cancelled') THEN error_code
             ELSE NULL
           END
       WHERE dispatch_id = ?
         AND state IN ('reserved', 'running', 'succeeded', 'failed', 'cancelled')
         AND reserved_by_invocation = ?`,
    )
    .bind(now, dispatchId, invocationId)
    .run();
  if (Number(result.meta.changes ?? 0) !== 1) throw new Error("dispatch_reservation_lost");
}

export async function markDispatchFailed(
  db: D1Database,
  input: {
    dispatchId: string;
    invocationId: string;
    errorCode: string;
    httpStatus: number | null;
    retryAtMs: number;
    nowMs: number;
  },
) {
  const updated = await db
    .prepare(
      `UPDATE workflow_dispatches
       SET state = 'failed', finished_at = ?, github_http_status = ?, error_code = ?,
           lease_until = NULL, next_attempt_at = ?
       WHERE dispatch_id = ? AND state = 'reserved' AND reserved_by_invocation = ?`,
    )
    .bind(
      new Date(input.nowMs).toISOString(),
      input.httpStatus,
      sanitizeErrorCode(input.errorCode),
      new Date(input.retryAtMs).toISOString(),
      input.dispatchId,
      input.invocationId,
    )
    .run();
  if (Number(updated.meta.changes ?? 0) === 1) return "failed" as const;
  const current = await db
    .prepare("SELECT state FROM workflow_dispatches WHERE dispatch_id = ?")
    .bind(input.dispatchId)
    .first<{ state: string }>();
  if (
    current &&
    ["accepted", "running", "succeeded", "failed", "cancelled"].includes(current.state)
  ) {
    return "callback_owned" as const;
  }
  throw new Error("dispatch_reservation_lost");
}

export async function markDispatchDiscordSent(
  db: D1Database,
  dispatchId: string,
  messageId: string,
  nowMs: number,
) {
  await db
    .prepare(
      `UPDATE workflow_dispatches SET discord_message_id = ?, discord_sent_at = ?
       WHERE dispatch_id = ? AND discord_sent_at IS NULL`,
    )
    .bind(messageId, new Date(nowMs).toISOString(), dispatchId)
    .run();
}

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
           ELSE excluded.first_seen_at
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

export async function updateObservedAlerts(
  db: D1Database,
  environment: DispatcherEnvironment,
  nowMs: number,
) {
  const now = new Date(nowMs).toISOString();
  const tenMinutesAgo = new Date(nowMs - 10 * 60 * 1_000).toISOString();
  const twentyMinutesAgo = new Date(nowMs - 20 * 60 * 1_000).toISOString();
  const oldest = await db
    .prepare(
      "SELECT MIN(first_seen_at) AS first_seen_at FROM source_queue WHERE status = 'pending'",
    )
    .first<{ first_seen_at: string | null }>();
  const pendingKey = `pending-delay:${environment}`;
  if (oldest?.first_seen_at && oldest.first_seen_at <= tenMinutesAgo) {
    await raiseOpsAlert(db, {
      alertKey: pendingKey,
      environment,
      severity: "warning",
      component: "source-queue",
      errorCode: "pending_over_10_minutes",
      context: { oldestPendingAt: oldest.first_seen_at },
      nowMs,
    });
  } else {
    await resolveOpsAlert(db, pendingKey, nowMs);
  }

  const latestCollector = await db
    .prepare(
      `SELECT status, error_code FROM collector_invocations ORDER BY scheduled_at DESC LIMIT 1`,
    )
    .first<{ status: string; error_code: string | null }>();
  const collectorKey = `collector-circuit:${environment}`;
  if (latestCollector?.status === "circuit_open") {
    await raiseOpsAlert(db, {
      alertKey: collectorKey,
      environment,
      severity: "critical",
      component: "collector",
      errorCode: "collector_circuit_open",
      context: { collectorError: latestCollector.error_code },
      nowMs,
    });
  } else if (latestCollector?.status === "completed") {
    await resolveOpsAlert(db, collectorKey, nowMs);
  }

  const actionable = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM source_queue WHERE status = 'pending') +
         (SELECT COUNT(*) FROM forecast_candidates WHERE state IN ('crosschecked', 'x_unavailable'))
         AS count`,
    )
    .first<{ count: number }>();
  const stale =
    Number(actionable?.count ?? 0) > 0
      ? await db
          .prepare(
            `SELECT dispatch_id, state, work_fingerprint
       FROM workflow_dispatches
       WHERE environment = ? AND state IN ('accepted', 'running')
         AND COALESCE(started_at, accepted_at, created_at) <= ?
       ORDER BY created_at LIMIT 5`,
          )
          .bind(environment, twentyMinutesAgo)
          .all<{ dispatch_id: string; state: string; work_fingerprint: string }>()
      : { results: [] };
  for (const row of stale.results) {
    await raiseOpsAlert(db, {
      alertKey: `dispatch-stale:${environment}:${row.dispatch_id}`,
      environment,
      severity: "critical",
      component: "github-workflow",
      errorCode: "dispatch_work_remaining_20_minutes",
      context: { dispatchId: row.dispatch_id, state: row.state },
      nowMs,
    });
  }
  if (Number(actionable?.count ?? 0) === 0) {
    await db
      .prepare(
        `UPDATE forecast_ops_alerts
         SET state = 'resolved', resolved_at = ?, next_send_at = ?
         WHERE environment = ? AND state = 'open' AND alert_key LIKE ?`,
      )
      .bind(now, now, environment, `dispatch-stale:${environment}:%`)
      .run();
  }

  const manual = await db
    .prepare(
      `SELECT q.source, q.item_id, q.title, q.url, q.error_code
       FROM source_queue q
       LEFT JOIN forecast_ops_alerts a
         ON a.alert_key = 'manual-review:' || ? || ':' || q.source || ':' || q.item_id
       WHERE q.status = 'manual_review' AND a.alert_key IS NULL
       ORDER BY q.updated_at LIMIT 10`,
    )
    .bind(environment)
    .all<{
      source: string;
      item_id: string;
      title: string;
      url: string;
      error_code: string | null;
    }>();
  for (const row of manual.results) {
    await raiseOpsAlert(db, {
      alertKey: `manual-review:${environment}:${row.source}:${row.item_id}`,
      environment,
      severity: "warning",
      component: "source-queue",
      errorCode: "source_item_manual_review",
      context: {
        source: row.source,
        itemId: row.item_id,
        title: bounded(row.title, 120),
        url: validatedNaverUrl(row.url),
        reason: row.error_code,
      },
      nowMs,
    });
  }

  await db
    .prepare(
      `UPDATE workflow_dispatches SET state = 'stale', finished_at = ?, error_code = 'reservation_abandoned'
       WHERE environment = ? AND state = 'reserved' AND lease_until < ?`,
    )
    .bind(now, environment, now)
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
              occurrence_count, last_sent_occurrence_count
       FROM forecast_ops_alerts
       WHERE environment = ? AND (
         (state = 'open' AND occurrence_count >= notify_after_count
          AND occurrence_count > last_sent_occurrence_count
          AND (next_send_at IS NULL OR next_send_at <= ?))
         OR
         (state = 'resolved' AND last_sent_at IS NOT NULL AND recovery_sent_at IS NULL)
       )
       ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, first_seen_at
       LIMIT ?`,
    )
    .bind(environment, now, Math.max(1, Math.min(20, Math.trunc(limit))))
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
         WHERE alert_key = ? AND state = 'resolved' AND recovery_sent_at IS NULL`,
      )
      .bind(now, messageId, alert.alertKey)
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE forecast_ops_alerts
       SET last_sent_at = ?, last_sent_occurrence_count = occurrence_count,
           next_send_at = ?, discord_message_id = ?, last_send_error = NULL
       WHERE alert_key = ? AND state = 'open'`,
    )
    .bind(now, new Date(nowMs + ALERT_SUPPRESSION_MS).toISOString(), messageId, alert.alertKey)
    .run();
}

export async function markAlertSendFailed(
  db: D1Database,
  alertKey: string,
  errorCode: string,
  nowMs: number,
) {
  await db
    .prepare(
      `UPDATE forecast_ops_alerts SET last_send_error = ?, next_send_at = ? WHERE alert_key = ?`,
    )
    .bind(sanitizeErrorCode(errorCode), new Date(nowMs + 5 * 60 * 1_000).toISOString(), alertKey)
    .run();
}

async function reservePendingSmoke(
  db: D1Database,
  input: {
    environment: DispatcherEnvironment;
    invocationId: string;
    deploymentSha: string;
    work: ActionableWork;
    nowMs: number;
  },
): Promise<DispatchReservation | null> {
  const now = new Date(input.nowMs).toISOString();
  const leaseUntil = new Date(input.nowMs + RESERVATION_LEASE_MS).toISOString();
  const pending = await db
    .prepare(
      `SELECT dispatch_id FROM workflow_dispatches
       WHERE environment = ? AND dispatch_mode = 'smoke'
         AND ((state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
              OR (state = 'reserved' AND lease_until < ?))
       ORDER BY created_at LIMIT 1`,
    )
    .bind(input.environment, now, now)
    .first<{ dispatch_id: string }>();
  if (!pending) return null;
  await db
    .prepare(
      `UPDATE workflow_dispatches
       SET state = 'reserved', reserved_by_invocation = ?, dispatcher_deployment_sha = ?, lease_until = ?,
           attempt = CASE WHEN state = 'reserved' THEN attempt + 1 ELSE attempt END,
           error_code = NULL
       WHERE dispatch_id = ? AND (
         (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (state = 'reserved' AND lease_until < ?)
       )`,
    )
    .bind(input.invocationId, input.deploymentSha, leaseUntil, pending.dispatch_id, now, now)
    .run();
  const row = await db
    .prepare(
      `SELECT dispatch_id, work_fingerprint, attempt FROM workflow_dispatches
       WHERE dispatch_id = ? AND state = 'reserved' AND reserved_by_invocation = ?`,
    )
    .bind(pending.dispatch_id, input.invocationId)
    .first<{ dispatch_id: string; work_fingerprint: string; attempt: number }>();
  return row
    ? {
        dispatchId: row.dispatch_id,
        mode: "smoke",
        fingerprint: row.work_fingerprint,
        pendingCount: 0,
        candidateCount: 0,
        attempt: Number(row.attempt),
        links: [],
      }
    : null;
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

function validatedNaverUrl(value: string) {
  const url = URL.parse(value);
  return url?.protocol === "https:" && url.hostname === "game.naver.com"
    ? url.toString()
    : "https://game.naver.com/lounge/nikke/home";
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

export function sanitizeErrorCode(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "unknown";
}
