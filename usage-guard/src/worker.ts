import {
  type CloudflarePaidUsageSnapshot,
  type D1BudgetEvaluation,
  evaluateD1CanaryBudget,
  evaluateD1PreflightBudget,
  fetchCloudflarePaidUsageSnapshot,
} from "../../shared/cloudflarePaidUsage.ts";
import {
  type CloudflareQuotaAction,
  type D1QuotaEvidence,
  QUOTA_ACTIONS,
} from "../../shared/d1QuotaEvidence.ts";
import { effectiveUsageGuardAction } from "../../shared/usageGuard.ts";
import type { StoredGuardState, StoredSnapshot, UsageGuardEnv } from "./types";

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;
const THIRTY_MINUTES_MS = 30 * 60 * 1_000;

export default {
  async scheduled(event, env, context) {
    context.waitUntil(runUsageGuard(env, event.scheduledTime));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/admin/refresh") {
      if (!(await timingSafeBearer(request, env.ADMIN_TOKEN))) {
        return Response.json(
          { error: "unauthorized" },
          { status: 401, headers: { "cache-control": "no-store" } },
        );
      }
      await runUsageGuard(env, Date.now());
      return Response.json(
        { ok: true, state: await readState(env.GUARD_DB) },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (request.method !== "GET" || url.pathname !== "/health") {
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    }
    const state = await readState(env.GUARD_DB);
    const latestRun = await env.GUARD_DB.prepare(
      `SELECT status, started_at, finished_at, error_code, effective_action
       FROM usage_guard_runs ORDER BY started_at DESC LIMIT 1`,
    ).first<Record<string, unknown>>();
    const effectiveAction = state
      ? effectiveUsageGuardAction(
          {
            action: parseAction(state.action),
            observedAt: state.observed_at,
            periodStart: state.period_start,
            periodEnd: state.period_end,
            evidenceHash: state.evidence_hash,
          },
          Date.now(),
        )
      : "hard_stop";
    return Response.json(
      {
        ok: state !== null && latestRun?.["status"] === "completed",
        environment: env.ENVIRONMENT,
        deploymentSha: env.DEPLOY_SHA,
        effectiveAction,
        state: state
          ? {
              action: effectiveAction,
              observedAt: state.observed_at,
              periodStart: state.period_start,
              periodEnd: state.period_end,
              currentPercent: state.current_percent,
              projectedPercent: state.projected_percent,
              governingMetric: state.governing_metric,
            }
          : null,
        latestRun,
      },
      { headers: { "cache-control": "no-store" } },
    );
  },
} satisfies ExportedHandler<UsageGuardEnv>;

export async function runUsageGuard(env: UsageGuardEnv, scheduledTime: number) {
  const startedAt = new Date().toISOString();
  const scheduledAt = new Date(scheduledTime).toISOString();
  const runId = await usageGuardRunId(env.DEPLOY_SHA, scheduledAt);
  const reservation = await env.GUARD_DB.prepare(
    `INSERT INTO usage_guard_runs (
       run_id, scheduled_at, started_at, status, deployment_sha
     ) VALUES (?, ?, ?, 'running', ?)
     ON CONFLICT(run_id) DO NOTHING`,
  )
    .bind(runId, scheduledAt, startedAt, env.DEPLOY_SHA)
    .run();
  if (reservation.meta.changes === 0) return;

  try {
    const snapshot = await fetchCloudflarePaidUsageSnapshot({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      analyticsToken: env.CLOUDFLARE_D1_ANALYTICS_TOKEN,
      billingToken: env.CLOUDFLARE_BILLING_READ_TOKEN,
      nowMs: Date.now(),
    });
    const baseline = await findQuotaBaseline(env.GUARD_DB, snapshot);
    const evaluation = baseline
      ? evaluateD1CanaryBudget(baseline, snapshot)
      : evaluateD1PreflightBudget(snapshot);
    const evidence = evaluation.evidence;
    if (!evidence) throw new Error("usage_guard_evidence_missing");
    await recordSuccessfulEvaluation(env, snapshot, evaluation, evidence, runId);
  } catch (error) {
    const errorCode = safeErrorCode(error);
    await env.GUARD_DB.prepare(
      `UPDATE usage_guard_runs
       SET finished_at = ?, status = 'failure', error_code = ?
       WHERE run_id = ?`,
    )
      .bind(new Date().toISOString(), errorCode, runId)
      .run();
    console.error(
      JSON.stringify({
        event: "usage_guard_failure",
        errorCode,
        deploymentSha: env.DEPLOY_SHA,
      }),
    );
    throw error;
  }
}

async function recordSuccessfulEvaluation(
  env: UsageGuardEnv,
  snapshot: CloudflarePaidUsageSnapshot,
  evaluation: D1BudgetEvaluation,
  evidence: D1QuotaEvidence,
  runId: string,
) {
  const previous = await readState(env.GUARD_DB);
  const transition = transitionAction(previous, evidence);
  const evidenceJson = stableJson(evidence);
  const evidenceHash = await sha256Hex(evidenceJson);
  const snapshotJson = stableJson(snapshot);
  const snapshotHash = await sha256Hex(snapshotJson);
  const snapshotId = await sha256Hex(`${snapshot.plan.periodStart}\n${snapshot.capturedAt}`);
  const finishedAt = new Date().toISOString();
  const alertRequired = actionAlertRequired(previous, transition.action);

  await env.GUARD_DB.batch([
    env.GUARD_DB.prepare(
      `INSERT INTO usage_guard_snapshots (
         snapshot_id, captured_at, period_start, period_end,
         snapshot_json, snapshot_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id) DO NOTHING`,
    ).bind(
      snapshotId,
      snapshot.capturedAt,
      snapshot.plan.periodStart,
      snapshot.plan.periodEnd,
      snapshotJson,
      snapshotHash,
      finishedAt,
    ),
    env.GUARD_DB.prepare(
      `INSERT INTO usage_guard_state (
         singleton_id, action, observed_at, period_start, period_end,
         evidence_json, evidence_hash, current_percent, projected_percent,
         governing_metric, normal_streak, release_pending, last_alert_action, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton_id) DO UPDATE SET
         action = excluded.action,
         observed_at = excluded.observed_at,
         period_start = excluded.period_start,
         period_end = excluded.period_end,
         evidence_json = excluded.evidence_json,
         evidence_hash = excluded.evidence_hash,
         current_percent = excluded.current_percent,
         projected_percent = excluded.projected_percent,
         governing_metric = excluded.governing_metric,
         normal_streak = excluded.normal_streak,
         release_pending = excluded.release_pending,
         last_alert_action = excluded.last_alert_action,
         updated_at = excluded.updated_at`,
    ).bind(
      transition.action,
      evidence.observedAt,
      evidence.plan.periodStart,
      evidence.plan.periodEnd,
      evidenceJson,
      evidenceHash,
      evidence.utilization.currentPercent,
      evidence.utilization.projectedPercent,
      evidence.utilization.governingMetric,
      transition.normalStreak,
      transition.releasePending ? 1 : 0,
      previous?.last_alert_action ?? null,
      finishedAt,
    ),
    env.GUARD_DB.prepare(
      `UPDATE usage_guard_runs
       SET finished_at = ?, status = 'completed', evaluated_action = ?,
           effective_action = ?, alert_status = ?
       WHERE run_id = ?`,
    ).bind(
      finishedAt,
      evaluation.action,
      transition.action,
      alertRequired ? "pending" : "unchanged",
      runId,
    ),
    env.GUARD_DB.prepare(`DELETE FROM usage_guard_snapshots WHERE captured_at < ?`).bind(
      new Date(Date.now() - 8 * 60 * 60 * 1_000).toISOString(),
    ),
  ]);

  if (!alertRequired) return;
  const alertStatus = await sendQuotaAlert(
    env,
    evidence,
    transition.action,
    previous?.action ?? null,
  );
  await env.GUARD_DB.prepare(`UPDATE usage_guard_runs SET alert_status = ? WHERE run_id = ?`)
    .bind(alertStatus, runId)
    .run();
  if (alertStatus === "sent") {
    await env.GUARD_DB.prepare(
      `UPDATE usage_guard_state
       SET last_alert_action = ?, updated_at = ?
       WHERE singleton_id = 1 AND action = ?`,
    )
      .bind(transition.action, new Date().toISOString(), transition.action)
      .run();
  }
}

export function transitionAction(
  previous: StoredGuardState | null,
  evidence: D1QuotaEvidence,
): { action: CloudflareQuotaAction; normalStreak: number; releasePending: boolean } {
  const evaluated = evidence.action;
  if (!previous) {
    return {
      action: evaluated,
      normalStreak: evaluated === "normal" ? 1 : 0,
      releasePending: false,
    };
  }
  const previousAction = parseAction(previous.action);
  if (previous.period_start === evidence.plan.periodStart) {
    if (previous.release_pending === 1 && evaluated === "normal") {
      if (previous.normal_streak < 1) {
        return { action: previousAction, normalStreak: 1, releasePending: true };
      }
      return { action: "normal", normalStreak: 2, releasePending: false };
    }
    return {
      action: actionRank(evaluated) > actionRank(previousAction) ? evaluated : previousAction,
      normalStreak: evaluated === "normal" ? previous.normal_streak + 1 : 0,
      releasePending: previous.release_pending === 1,
    };
  }
  if (evaluated !== "normal") {
    const action = actionRank(evaluated) > actionRank(previousAction) ? evaluated : previousAction;
    return {
      action,
      normalStreak: 0,
      releasePending: actionRank(action) > actionRank("normal"),
    };
  }
  return {
    action: previousAction,
    normalStreak: 1,
    releasePending: previousAction !== "normal",
  };
}

export function usageGuardRunId(deploymentSha: string, scheduledAt: string) {
  return sha256Hex(`${deploymentSha}\n${scheduledAt}`);
}

export function actionAlertRequired(
  previous: Pick<StoredGuardState, "last_alert_action"> | null,
  nextAction: CloudflareQuotaAction,
) {
  return previous ? previous.last_alert_action !== nextAction : nextAction !== "normal";
}

export async function findQuotaBaseline(
  db: D1Database,
  snapshot: Pick<CloudflarePaidUsageSnapshot, "capturedAt" | "plan">,
) {
  const latestAllowed = new Date(Date.parse(snapshot.capturedAt) - THIRTY_MINUTES_MS).toISOString();
  const earliestAllowed = new Date(Date.parse(snapshot.capturedAt) - SIX_HOURS_MS).toISOString();
  const row = await db
    .prepare(
      `SELECT snapshot_json, snapshot_hash, captured_at
       FROM usage_guard_snapshots
       WHERE period_start = ? AND captured_at BETWEEN ? AND ?
       ORDER BY captured_at ASC LIMIT 1`,
    )
    .bind(snapshot.plan.periodStart, earliestAllowed, latestAllowed)
    .first<StoredSnapshot>();
  if (!row) return null;
  if ((await sha256Hex(row.snapshot_json)) !== row.snapshot_hash) {
    throw new Error("usage_guard_snapshot_hash_mismatch");
  }
  return JSON.parse(row.snapshot_json) as CloudflarePaidUsageSnapshot;
}

async function readState(db: D1Database) {
  return db
    .prepare(
      `SELECT action, observed_at, period_start, period_end, evidence_json,
              evidence_hash, current_percent, projected_percent, governing_metric,
              normal_streak, release_pending, last_alert_action
       FROM usage_guard_state WHERE singleton_id = 1`,
    )
    .first<StoredGuardState>();
}

async function sendQuotaAlert(
  env: UsageGuardEnv,
  evidence: D1QuotaEvidence,
  effectiveAction: CloudflareQuotaAction,
  previousAction: string | null,
) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_ALERT_CHANNEL_ID) return "not_configured";
  const recovering = effectiveAction === "normal" && previousAction !== null;
  try {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${env.DISCORD_ALERT_CHANNEL_ID}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          allowed_mentions: { parse: [] },
          embeds: [
            {
              title: recovering
                ? "Cloudflare quota guard 복구"
                : "Cloudflare quota guard 단계 변경",
              description: [
                `상태: **${effectiveAction}**`,
                `현재 사용률: ${evidence.utilization.currentPercent.toFixed(3)}%`,
                `월말 예상: ${evidence.utilization.projectedPercent.toFixed(3)}%`,
                `지배 지표: ${evidence.utilization.governingMetric}`,
                `결제 기간: ${evidence.plan.periodStart} ~ ${evidence.plan.periodEnd}`,
              ].join("\n"),
              color: recovering ? 0x2ecc71 : effectiveAction === "warning" ? 0xf1c40f : 0xe74c3c,
            },
          ],
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.ok) {
      await response.body?.cancel();
      return "sent";
    }
    await response.body?.cancel();
    return `discord_http_${response.status}`;
  } catch (error) {
    return safeErrorCode(error).startsWith("usage_guard_")
      ? safeErrorCode(error)
      : `discord_transport_${safeErrorCode(error)}`;
  }
}

function parseAction(value: string): CloudflareQuotaAction {
  if ((QUOTA_ACTIONS as readonly string[]).includes(value)) return value as CloudflareQuotaAction;
  return "hard_stop";
}

function actionRank(action: CloudflareQuotaAction) {
  return QUOTA_ACTIONS.indexOf(action);
}

function stableJson(value: unknown) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "usage_guard_unknown_error";
  return message.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 160);
}

async function timingSafeBearer(request: Request, expected: string) {
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!provided || !expected) return false;
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(provided)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let different = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    different |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return different === 0;
}
