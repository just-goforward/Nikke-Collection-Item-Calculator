import { sha256Hex } from "./crypto";

const REPOSITORY = "just-goforward/Nikke-Collection-Item-Calculator";
const DISPATCH_ID_PATTERN = /^fd-[0-9a-f]{32}$/;

export type OpsEnvironment = "staging" | "production";
export type OpsSeverity = "warning" | "critical";

export type WorkflowStatusInput = {
  phase: "started" | "finished";
  runId: number;
  runAttempt: number;
  runUrl: string;
  conclusion?: "success" | "failure" | "cancelled";
};

export async function upsertOpsAlert(
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
  },
) {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const nextSendAt = now;
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
      errorCode(input.errorCode),
      contextJson(input.context),
      Math.max(1, Math.trunc(input.notifyAfterCount ?? 1)),
      now,
      now,
      nextSendAt,
    )
    .run();
}

async function resolveOpsAlert(db: D1Database, alertKey: string, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  await db
    .prepare(
      `UPDATE forecast_ops_alerts
       SET state = 'resolved', resolved_at = ?, next_send_at = ?
       WHERE alert_key = ? AND state = 'open'`,
    )
    .bind(now, now, bounded(alertKey, 160))
    .run();
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

export async function createDispatcherSmoke(
  db: D1Database,
  environment: OpsEnvironment,
  requestKey: string,
  nowMs = Date.now(),
) {
  if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(requestKey)) throw new Error("invalid_smoke_request_key");
  const fingerprint = await sha256Hex(`smoke:${environment}:${requestKey}`);
  const dispatchId = `fd-${fingerprint.slice(0, 32)}`;
  const now = new Date(nowMs).toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO workflow_dispatches (
         dispatch_id, slot_key, environment, dispatch_mode, work_fingerprint,
         pending_count, candidate_count, attempt, state, created_at, next_attempt_at
       ) VALUES (?, ?, ?, 'smoke', ?, 0, 0, 1, 'pending', ?, ?)`,
    )
    .bind(dispatchId, `smoke:${environment}:${requestKey}`, environment, fingerprint, now, now)
    .run();
  const row = await db
    .prepare(
      `SELECT dispatch_id, state, created_at FROM workflow_dispatches
       WHERE dispatch_id = ? AND dispatch_mode = 'smoke'`,
    )
    .bind(dispatchId)
    .first<{ dispatch_id: string; state: string; created_at: string }>();
  if (!row) throw new Error("dispatcher_smoke_missing_after_insert");
  return { dispatchId: row.dispatch_id, state: row.state, createdAt: row.created_at };
}

export async function recordWorkflowDispatchStatus(
  db: D1Database,
  environment: OpsEnvironment,
  dispatchId: string,
  raw: unknown,
  nowMs = Date.now(),
) {
  if (!DISPATCH_ID_PATTERN.test(dispatchId)) throw new Error("invalid_dispatch_id");
  const input = parseWorkflowStatus(raw);
  const row = await db
    .prepare(
      `SELECT state, github_run_id, github_run_attempt, github_run_url
       FROM workflow_dispatches WHERE dispatch_id = ? AND environment = ?`,
    )
    .bind(dispatchId, environment)
    .first<{
      state: string;
      github_run_id: number | null;
      github_run_attempt: number | null;
      github_run_url: string | null;
    }>();
  if (!row) throw new Error("workflow_dispatch_not_found");
  assertRunIdentity(row, input);
  const now = new Date(nowMs).toISOString();

  if (input.phase === "started") {
    if (["succeeded", "failed", "cancelled", "stale"].includes(row.state)) {
      throw new Error("workflow_dispatch_state_regression");
    }
    if (!["reserved", "accepted", "running"].includes(row.state))
      throw new Error("workflow_dispatch_state_regression");
    await db
      .prepare(
        `UPDATE workflow_dispatches
         SET state = 'running', started_at = COALESCE(started_at, ?),
             github_run_id = ?, github_run_attempt = ?, github_run_url = ?
         WHERE dispatch_id = ? AND environment = ?`,
      )
      .bind(now, input.runId, input.runAttempt, input.runUrl, dispatchId, environment)
      .run();
    await resolveOpsAlert(db, `github-dispatch:${environment}`, nowMs);
    return { dispatchId, state: "running" as const };
  }

  const conclusion = input.conclusion;
  if (!conclusion) throw new Error("workflow_dispatch_missing_conclusion");
  const state =
    conclusion === "success" ? "succeeded" : conclusion === "failure" ? "failed" : "cancelled";
  if (["succeeded", "failed", "cancelled"].includes(row.state) && row.state !== state) {
    throw new Error("workflow_dispatch_terminal_conflict");
  }
  if (row.state === state) return { dispatchId, state };
  if (row.state !== "running") throw new Error("workflow_dispatch_state_regression");
  await db
    .prepare(
      `UPDATE workflow_dispatches
       SET state = ?, finished_at = COALESCE(finished_at, ?),
           github_run_id = ?, github_run_attempt = ?, github_run_url = ?,
           error_code = CASE WHEN ? = 'succeeded' THEN NULL ELSE 'github_workflow_' || ? END
       WHERE dispatch_id = ? AND environment = ?`,
    )
    .bind(
      state,
      now,
      input.runId,
      input.runAttempt,
      input.runUrl,
      state,
      state,
      dispatchId,
      environment,
    )
    .run();
  const alertKey = `workflow:${environment}:${dispatchId}`;
  if (state === "succeeded") {
    await resolveOpsAlert(db, alertKey, nowMs);
  } else {
    await upsertOpsAlert(db, {
      alertKey,
      environment,
      severity: "critical",
      component: "github-workflow",
      errorCode: `github_workflow_${state}`,
      context: { dispatchId, runId: input.runId, runUrl: input.runUrl },
      nowMs,
    });
  }
  return { dispatchId, state };
}

export async function readWorkflowDispatch(
  db: D1Database,
  environment: OpsEnvironment,
  dispatchId: string,
) {
  if (!DISPATCH_ID_PATTERN.test(dispatchId)) throw new Error("invalid_dispatch_id");
  const row = await db
    .prepare(
      `SELECT dispatch_id, dispatch_mode, state, pending_count, candidate_count, attempt,
              created_at, accepted_at, started_at, finished_at, github_run_id,
              github_run_attempt, github_run_url, error_code, discord_sent_at
       FROM workflow_dispatches WHERE dispatch_id = ? AND environment = ?`,
    )
    .bind(dispatchId, environment)
    .first<{
      dispatch_id: string;
      dispatch_mode: "work" | "smoke";
      state: string;
      pending_count: number;
      candidate_count: number;
      attempt: number;
      created_at: string;
      accepted_at: string | null;
      started_at: string | null;
      finished_at: string | null;
      github_run_id: number | null;
      github_run_attempt: number | null;
      github_run_url: string | null;
      error_code: string | null;
      discord_sent_at: string | null;
    }>();
  return row
    ? {
        dispatchId: row.dispatch_id,
        mode: row.dispatch_mode,
        state: row.state,
        pendingCount: Number(row.pending_count),
        candidateCount: Number(row.candidate_count),
        attempt: Number(row.attempt),
        createdAt: row.created_at,
        acceptedAt: row.accepted_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        runId: row.github_run_id,
        runAttempt: row.github_run_attempt,
        runUrl: row.github_run_url,
        errorCode: row.error_code,
        discordSentAt: row.discord_sent_at,
      }
    : null;
}

export async function recordWatchdogFallback(
  db: D1Database,
  environment: OpsEnvironment,
  raw: unknown,
  nowMs = Date.now(),
) {
  if (!isRecord(raw)) throw new Error("invalid_watchdog_fallback");
  const runId = raw["runId"];
  const runUrl = raw["runUrl"];
  if (
    !Number.isInteger(runId) ||
    Number(runId) <= 0 ||
    typeof runUrl !== "string" ||
    runUrl !== `https://github.com/${REPOSITORY}/actions/runs/${runId}`
  ) {
    throw new Error("invalid_watchdog_fallback");
  }
  await upsertOpsAlert(db, {
    alertKey: `watchdog-fallback:${environment}`,
    environment,
    severity: "warning",
    component: "github-watchdog",
    errorCode: "watchdog_fallback",
    context: { runId: Number(runId), runUrl },
    nowMs,
  });
  return { recorded: true as const };
}

export async function recordWatchdogNotificationFailure(
  db: D1Database,
  environment: OpsEnvironment,
  raw: unknown,
  nowMs = Date.now(),
) {
  const { runId, runUrl } = parseGithubRun(raw, "invalid_watchdog_notification_failure");
  await upsertOpsAlert(db, {
    alertKey: `watchdog-notification-failed:${environment}`,
    environment,
    severity: "critical",
    component: "github-watchdog",
    errorCode: "watchdog_notification_failed",
    context: { runId, runUrl },
    nowMs,
  });
  return { recorded: true as const };
}

export async function recordSourceProcessorInternalFailure(
  db: D1Database,
  environment: OpsEnvironment,
  raw: unknown,
  nowMs = Date.now(),
) {
  const { runId, runUrl } = parseGithubRun(raw, "invalid_source_processor_internal_failure");
  await upsertOpsAlert(db, {
    alertKey: `source-processor-internal:${environment}:${runId}`,
    environment,
    severity: "critical",
    component: "source-processor",
    errorCode: "source_processor_internal",
    context: { runId, runUrl },
    nowMs,
  });
  return { recorded: true as const };
}

function parseGithubRun(raw: unknown, invalidCode: string) {
  if (!isRecord(raw)) throw new Error(invalidCode);
  const runId = raw["runId"];
  const runUrl = raw["runUrl"];
  if (
    !Number.isInteger(runId) ||
    Number(runId) <= 0 ||
    typeof runUrl !== "string" ||
    runUrl !== `https://github.com/${REPOSITORY}/actions/runs/${runId}`
  ) {
    throw new Error(invalidCode);
  }
  return { runId: Number(runId), runUrl };
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

function parseWorkflowStatus(raw: unknown): WorkflowStatusInput {
  if (!isRecord(raw)) throw new Error("invalid_workflow_status");
  const phase = raw["phase"];
  const runId = raw["runId"];
  const runAttempt = raw["runAttempt"];
  const runUrl = raw["runUrl"];
  const conclusion = raw["conclusion"];
  const identity = parseRunIdentity(runId, runAttempt, runUrl);
  if (!validWorkflowPhase(phase) || !identity) throw new Error("invalid_workflow_status");
  if (phase === "started") {
    if (conclusion !== undefined) throw new Error("invalid_workflow_status");
    return { phase, ...identity };
  }
  if (!validWorkflowConclusion(conclusion)) throw new Error("invalid_workflow_status");
  return { phase, ...identity, conclusion };
}

function validWorkflowPhase(value: unknown): value is WorkflowStatusInput["phase"] {
  return value === "started" || value === "finished";
}

function parseRunIdentity(runId: unknown, runAttempt: unknown, runUrl: unknown) {
  if (!Number.isInteger(runId) || Number(runId) <= 0) return null;
  if (!Number.isInteger(runAttempt) || Number(runAttempt) <= 0) return null;
  if (typeof runUrl !== "string") return null;
  if (runUrl !== `https://github.com/${REPOSITORY}/actions/runs/${runId}`) return null;
  return { runId: Number(runId), runAttempt: Number(runAttempt), runUrl };
}

function validWorkflowConclusion(
  value: unknown,
): value is NonNullable<WorkflowStatusInput["conclusion"]> {
  return value === "success" || value === "failure" || value === "cancelled";
}

function assertRunIdentity(
  row: {
    github_run_id: number | null;
    github_run_attempt: number | null;
    github_run_url: string | null;
  },
  input: WorkflowStatusInput,
) {
  if (
    (row.github_run_id !== null && row.github_run_id !== input.runId) ||
    (row.github_run_attempt !== null && row.github_run_attempt !== input.runAttempt) ||
    (row.github_run_url !== null && row.github_run_url !== input.runUrl)
  ) {
    throw new Error("workflow_dispatch_run_identity_conflict");
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
