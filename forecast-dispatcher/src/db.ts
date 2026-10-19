import { sha256Hex } from "./crypto";
import type {
  ActionableWork,
  DispatcherEnvironment,
  DispatchReservation,
  OpsAlertRow,
  WorkLink,
} from "./types";

const RESERVATION_LEASE_MS = 5 * 60 * 1_000;
type ReviewEvidence = {
  block_index: number;
  judged_at: string;
  reason: string | null;
  question: string;
  triggers_json: string;
  block_excerpt: string;
  comparison_json: string;
  expires_at: string | null;
};

export async function readManualReviewEvidence(
  db: D1Database,
  alert: OpsAlertRow,
): Promise<ReviewEvidence[]> {
  if (!alert.alertKey.startsWith("manual-review:")) return [];
  const { source, itemId, reviewId } = alert.context;
  if (typeof source !== "string" || typeof itemId !== "string") return [];
  try {
    const result = await db
      .prepare(
        `WITH latest AS (
          SELECT e.content_hash, e.rule_version, e.context_hash FROM source_judgment_evidence e
          JOIN source_manual_reviews r ON r.source=e.source AND r.item_id=e.item_id
          JOIN source_manual_review_bindings b ON b.review_id=r.review_id
            AND b.generation=r.generation AND b.body_hash=e.content_hash
          WHERE e.source = ? AND e.item_id = ? AND r.review_id = ?
            AND (json_extract(b.metadata_json,'$.contextHash') IS NULL
              OR e.context_hash=json_extract(b.metadata_json,'$.contextHash'))
          GROUP BY e.content_hash, e.rule_version, e.context_hash
          ORDER BY MAX(e.judged_at) DESC, e.rule_version DESC LIMIT 1
        )
        SELECT e.block_index,e.judged_at,e.reason,e.question,e.triggers_json,
          e.block_excerpt,e.comparison_json,
          (SELECT expires_at FROM source_manual_reviews WHERE review_id = ?) AS expires_at
        FROM source_judgment_evidence e JOIN latest l
          ON e.content_hash=l.content_hash AND e.rule_version=l.rule_version
            AND e.context_hash=l.context_hash
        WHERE e.source=? AND e.item_id=? AND e.verdict='manual_review'
        ORDER BY e.block_index LIMIT 3`,
      )
      .bind(source, itemId, reviewId ?? "", reviewId ?? "", source, itemId)
      .all<ReviewEvidence>();
    return result.results;
  } catch (error) {
    if (
      error instanceof Error &&
      /no such table: (?:main\.)?source_(?:judgment_evidence|manual_review_bindings|manual_reviews)\b/.test(
        error.message,
      )
    )
      return [];
    throw error;
  }
}
const RECENT_DISPATCH_MS = 20 * 60 * 1_000;
const ALERT_SUPPRESSION_MS = 30 * 60 * 1_000;
const MAX_WORK_IDS = 1_000;
const EMPTY_WORK_FINGERPRINTS: Record<DispatcherEnvironment, string> = {
  staging: "faee245f61e12ff37e07bdd6778379da818d2c3dbf1b76e545babc3e5e012c6b",
  production: "c5056c85d91b2c5f076950484107ac80d8b395c0706ba389e9f3dc0ce6382a62",
};

export async function readActionableWork(
  db: D1Database,
  environment: DispatcherEnvironment,
): Promise<ActionableWork> {
  const [pendingResult, candidateResult] = await db.batch([
    db
      .prepare(
        `SELECT source, item_id, title, url
       FROM source_queue WHERE status = 'pending'
       ORDER BY published_at, source, item_id LIMIT ?`,
      )
      .bind(MAX_WORK_IDS + 1),
    db
      .prepare(
        `SELECT candidate_id FROM forecast_candidates
       WHERE state IN ('crosschecked', 'x_unavailable')
       ORDER BY created_at, candidate_id LIMIT ?`,
      )
      .bind(MAX_WORK_IDS + 1),
  ]);
  if (!pendingResult || !candidateResult) throw new Error("actionable_work_batch_incomplete");
  const pending = pendingResult.results as Array<{
    source: WorkLink["source"];
    item_id: string;
    title: string;
    url: string;
  }>;
  const candidates = candidateResult.results as Array<{ candidate_id: string }>;
  if (pending.length > MAX_WORK_IDS || candidates.length > MAX_WORK_IDS) {
    throw new Error("actionable_work_overflow");
  }
  const pendingIds = pending.map((row) => `${row.source}:${row.item_id}`).sort();
  const candidateIds = candidates.map((row) => row.candidate_id).sort();
  const fingerprint =
    pendingIds.length + candidateIds.length === 0
      ? EMPTY_WORK_FINGERPRINTS[environment]
      : await sha256Hex(
          JSON.stringify({ environment, pending: pendingIds, candidates: candidateIds }),
        );
  return {
    pendingIds,
    candidateIds,
    links: pending.slice(0, 3).map((row) => ({
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
  github: { status: 200 | 204; runId: number | null; runUrl: string | null },
) {
  const now = new Date(nowMs).toISOString();
  const result = await db
    .prepare(
      `UPDATE workflow_dispatches
       SET state = CASE
             WHEN state IN ('running', 'succeeded', 'failed', 'cancelled') THEN state
             ELSE 'accepted'
           END,
           accepted_at = COALESCE(accepted_at, ?), github_http_status = ?,
           github_run_id = COALESCE(github_run_id, ?),
           github_run_attempt = CASE
             WHEN github_run_id IS NULL AND ? IS NOT NULL THEN 1
             ELSE github_run_attempt
           END,
           github_run_url = COALESCE(github_run_url, ?),
           lease_until = NULL, next_attempt_at = NULL,
           error_code = CASE
             WHEN state IN ('succeeded', 'failed', 'cancelled') THEN error_code
             ELSE NULL
           END
       WHERE dispatch_id = ?
         AND state IN ('reserved', 'running', 'succeeded', 'failed', 'cancelled')
         AND reserved_by_invocation = ?`,
    )
    .bind(now, github.status, github.runId, github.runId, github.runUrl, dispatchId, invocationId)
    .run();
  if (Number(result.meta.changes ?? 0) !== 1) throw new Error("dispatch_reservation_lost");
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
