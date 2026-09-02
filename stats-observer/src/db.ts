import { nextSeverity } from "./policy";
import type { ObserverAlertRow, SourceObservation, StatsObserverEnv } from "./types";

export async function beginRun(env: StatsObserverEnv, runId: string, scheduledAt: string, now: string) {
  const result = await env.OBSERVER_DB.prepare(
    `INSERT OR IGNORE INTO observer_runs
      (run_id, scheduled_at, started_at, status, deployment_sha)
     VALUES (?, ?, ?, 'running', ?)`,
  )
    .bind(runId, scheduledAt, now, normalizedDeploySha(env.DEPLOY_SHA))
    .run();
  const inserted = Number(result.meta.changes ?? 0) === 1;
  if (!inserted) {
    await env.OBSERVER_DB.prepare(
      `UPDATE observer_runs SET duplicate_attempts = duplicate_attempts + 1 WHERE run_id = ?`,
    )
      .bind(runId)
      .run();
  }
  return inserted;
}

export async function finishRun(
  env: StatsObserverEnv,
  runId: string,
  input: { rows: number; deltas: number; alerts: number },
) {
  await env.OBSERVER_DB.prepare(
    `UPDATE observer_runs
     SET status = 'completed', finished_at = ?, rows_observed = ?,
         deltas_observed = ?, alerts_attempted = ?, error_code = NULL
     WHERE run_id = ? AND status = 'running'`,
  )
    .bind(new Date().toISOString(), input.rows, input.deltas, input.alerts, runId)
    .run();
}

export async function failRun(env: StatsObserverEnv, runId: string, errorCode: string) {
  await env.OBSERVER_DB.prepare(
    `UPDATE observer_runs
     SET status = 'failure', finished_at = ?, error_code = ?
     WHERE run_id = ? AND status = 'running'`,
  )
    .bind(new Date().toISOString(), safeToken(errorCode, "observer_internal_error"), runId)
    .run();
}

export async function isBaselineInitialized(env: StatsObserverEnv) {
  const row = await env.OBSERVER_DB.prepare(
    "SELECT baseline_initialized FROM observer_state WHERE singleton_id = 1",
  ).first<{ baseline_initialized?: number }>();
  return row?.baseline_initialized === 1;
}

export async function initializeBaseline(
  env: StatsObserverEnv,
  sources: Array<{ sourceKind: string; rowHash: string; events: number; lastSeen: number }>,
  now: string,
) {
  const statements = sources.map((source) =>
    env.OBSERVER_DB.prepare(
      `INSERT INTO observer_source_cursors
        (source_kind, row_hash, last_events, source_last_seen, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_kind, row_hash) DO UPDATE SET
        last_events = excluded.last_events,
        source_last_seen = excluded.source_last_seen,
        updated_at = excluded.updated_at`,
    ).bind(source.sourceKind, source.rowHash, source.events, source.lastSeen, now),
  );
  statements.push(
    env.OBSERVER_DB.prepare(
      `UPDATE observer_state
       SET baseline_initialized = 1, baseline_at = ?, last_poll_at = ?, updated_at = ?
       WHERE singleton_id = 1`,
    ).bind(now, now, now),
  );
  await env.OBSERVER_DB.batch(statements);
}

export async function sourceCursor(
  env: StatsObserverEnv,
  sourceKind: string,
  rowHash: string,
) {
  return await env.OBSERVER_DB.prepare(
    `SELECT last_events FROM observer_source_cursors
     WHERE source_kind = ? AND row_hash = ?`,
  )
    .bind(sourceKind, rowHash)
    .first<{ last_events?: number }>();
}

export function updateSourceCursorStatement(
  env: StatsObserverEnv,
  sourceKind: string,
  rowHash: string,
  events: number,
  lastSeen: number,
  now: string,
) {
  return env.OBSERVER_DB.prepare(
    `INSERT INTO observer_source_cursors
      (source_kind, row_hash, last_events, source_last_seen, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_kind, row_hash) DO UPDATE SET
      last_events = excluded.last_events,
      source_last_seen = excluded.source_last_seen,
      updated_at = excluded.updated_at`,
  )
    .bind(sourceKind, rowHash, events, lastSeen, now);
}

export async function recordDeltaStatement(
  env: StatsObserverEnv,
  observation: SourceObservation,
  fingerprint: string,
  delta: number,
  now: string,
) {
  const current = await env.OBSERVER_DB.prepare(
    `SELECT severity, window_started_at, window_count, total_count,
            last_sent_at, last_sent_severity, discord_message_id
     FROM observer_alerts WHERE fingerprint = ?`,
  )
    .bind(fingerprint)
    .first<Record<string, unknown>>();
  const nowMs = Date.parse(now);
  const currentWindowStart = Date.parse(String(current?.["window_started_at"] ?? ""));
  const sameWindow = Number.isFinite(currentWindowStart) && nowMs - currentWindowStart < 30 * 60_000;
  const windowStartedAt = sameWindow ? new Date(currentWindowStart).toISOString() : now;
  const windowCount = (sameWindow ? numberOrZero(current?.["window_count"]) : 0) + delta;
  const totalCount = numberOrZero(current?.["total_count"]) + delta;
  const severity = nextSeverity(observation.immediateCritical, windowCount);
  const contextJson = JSON.stringify(observation.context);

  return env.OBSERVER_DB.prepare(
    `INSERT INTO observer_alerts
      (fingerprint, source_kind, severity, error_code, state, context_json,
       first_seen, last_seen, window_started_at, window_count, total_count,
       next_send_at, send_status, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(fingerprint) DO UPDATE SET
      source_kind = excluded.source_kind,
      severity = excluded.severity,
      error_code = excluded.error_code,
      state = 'open',
      context_json = excluded.context_json,
      last_seen = excluded.last_seen,
      window_started_at = excluded.window_started_at,
      window_count = excluded.window_count,
      total_count = excluded.total_count,
      next_send_at = excluded.next_send_at,
      send_status = 'pending',
      updated_at = excluded.updated_at`,
  )
    .bind(
      fingerprint,
      observation.sourceKind,
      severity,
      observation.errorCode,
      contextJson,
      new Date(observation.firstSeen * 1_000).toISOString(),
      new Date(observation.lastSeen * 1_000).toISOString(),
      windowStartedAt,
      windowCount,
      totalCount,
      now,
      now,
    );
}

export async function dueAlerts(env: StatsObserverEnv, now: string) {
  const result = await env.OBSERVER_DB.prepare(
    `SELECT fingerprint, source_kind, severity, error_code, state, context_json,
            first_seen, last_seen, window_started_at, window_count, total_count, last_sent_at,
            last_sent_severity, discord_message_id, next_send_at
     FROM observer_alerts
     WHERE state IN ('open', 'resolved') AND send_status = 'pending'
       AND next_send_at IS NOT NULL AND next_send_at <= ?
     ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, first_seen ASC
     LIMIT 20`,
  )
    .bind(now)
    .all<ObserverAlertRow>();
  return result.results ?? [];
}

export function resolveProvenAlertStatement(
  env: StatsObserverEnv,
  fingerprint: string,
  now: string,
) {
  return env.OBSERVER_DB.prepare(
    `UPDATE observer_alerts SET
      state = 'resolved', last_seen = ?, next_send_at = ?, send_status = 'pending', updated_at = ?
     WHERE fingerprint = ? AND state = 'open' AND last_sent_at IS NOT NULL`,
  )
    .bind(now, now, now, fingerprint);
}

export async function markAlertSent(
  env: StatsObserverEnv,
  alert: ObserverAlertRow,
  messageId: string,
  now: string,
) {
  await env.OBSERVER_DB.prepare(
    `UPDATE observer_alerts SET
      last_sent_at = ?, last_sent_severity = severity, discord_message_id = ?,
      next_send_at = NULL, send_status = 'sent', last_send_error = NULL, updated_at = ?
     WHERE fingerprint = ?`,
  )
    .bind(now, messageId, now, alert.fingerprint)
    .run();
}

export async function markAlertRetry(
  env: StatsObserverEnv,
  fingerprint: string,
  errorCode: string,
  nextSendAt: string | null,
) {
  await env.OBSERVER_DB.prepare(
    `UPDATE observer_alerts SET
      next_send_at = ?, send_status = ?, last_send_error = ?, updated_at = ?
     WHERE fingerprint = ?`,
  )
    .bind(
      nextSendAt,
      nextSendAt === null ? "failed" : "pending",
      safeToken(errorCode, "discord_error"),
      new Date().toISOString(),
      fingerprint,
    )
    .run();
}

export function touchPollStatement(env: StatsObserverEnv, now: string) {
  return env.OBSERVER_DB.prepare(
    `UPDATE observer_state SET last_poll_at = ?, updated_at = ? WHERE singleton_id = 1`,
  )
    .bind(now, now);
}

function numberOrZero(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function safeToken(value: string, fallback: string) {
  return /^[a-z0-9_]{1,64}$/.test(value) ? value : fallback;
}

function normalizedDeploySha(value: string) {
  return /^[0-9a-f]{40}$/.test(value) || value === "local" ? value : "unknown";
}
