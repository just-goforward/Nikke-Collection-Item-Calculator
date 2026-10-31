import { assertD1QuotaEvidence } from "../../shared/d1QuotaEvidence";
import {
  evaluateForecastRuntimeTelemetry,
  FORECAST_CANARY_POLICY_ID,
} from "../../shared/forecastCanaryRuntime";
import type { UsageGuardEvidence, UsageGuardState } from "../../shared/usageGuard";
import { assertCanaryStartWindow, CANARY_WINDOW_MS, readQuotaEvidence } from "./canary-quota";
import {
  CANARY_MINIMUM_COMPLETION_RATE,
  CANARY_MINIMUM_DELIVERY_RATE,
  CANARY_WINDOW_MODE,
  evaluateCanaryDecision,
  missingCanaryReport,
} from "./canary-report";
import { existingRunConflicts, validateCanaryStartInput } from "./canary-start-contract";
import { readV2CandidateIntegrity, readV2MonitorProgress } from "./canary-v2-evidence";
import { sha256Hex, stableJson } from "./crypto";

type Environment = "staging" | "production";
type PollMode = "both" | "alternating";
type CanaryRunRow = {
  canary_id: string;
  environment: Environment;
  deployment_sha: string;
  collector_cron: string;
  dispatcher_cron: string;
  collector_version_id: string;
  dispatcher_version_id: string;
  started_at: string;
  ends_at: string;
  quota_evidence_json: string;
  quota_evidence_hash: string;
};

export async function startCanaryDeployment(
  db: D1Database,
  input: {
    environment: Environment;
    canaryId: string;
    deploymentSha: string;
    collectorCron: string;
    dispatcherCron: string;
    collectorVersionId: string;
    dispatcherVersionId: string;
    quotaEvidence: unknown;
    nowMs?: number;
  },
) {
  validateCanaryStartInput(input);
  const quotaEvidence = assertD1QuotaEvidence(input.quotaEvidence);
  const quotaEvidenceJson = stableJson(quotaEvidence);
  const quotaEvidenceHash = await sha256Hex(quotaEvidenceJson);
  const existing = await readRunById(db, input.canaryId);
  if (existing) {
    if (existingRunConflicts(existing, input, quotaEvidenceHash))
      throw new Error("canary_run_conflict");
    return publicRun(existing);
  }
  const nowMs = input.nowMs ?? Date.now();
  assertCanaryStartWindow(nowMs, quotaEvidence);
  const startedAt = new Date(nowMs).toISOString();
  const endsAt = new Date(nowMs + CANARY_WINDOW_MS).toISOString();
  const overlapping = await db
    .prepare(
      `SELECT canary_id FROM canary_runs
       WHERE environment = ? AND deployment_sha = ? AND ends_at > ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .bind(input.environment, input.deploymentSha, startedAt)
    .first<{ canary_id: string }>();
  if (overlapping) throw new Error("canary_run_overlap");
  await db
    .prepare(
      `INSERT INTO canary_runs (
         canary_id, environment, deployment_sha, collector_cron, dispatcher_cron,
         collector_version_id, dispatcher_version_id, started_at, ends_at,
         quota_evidence_json, quota_evidence_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.canaryId,
      input.environment,
      input.deploymentSha,
      input.collectorCron,
      input.dispatcherCron,
      input.collectorVersionId.toLowerCase(),
      input.dispatcherVersionId.toLowerCase(),
      startedAt,
      endsAt,
      quotaEvidenceJson,
      quotaEvidenceHash,
      startedAt,
    )
    .run();
  const stored = await readRunById(db, input.canaryId);
  if (!stored) throw new Error("canary_run_missing_after_insert");
  return publicRun(stored);
}

export async function readCanaryReport(
  db: D1Database,
  nowMs: number,
  deploymentSha: string,
  environment: Environment = "staging",
  canaryId?: string,
  runtimeQuota?: UsageGuardEvidence | UsageGuardState,
  runtimeTelemetry?: unknown,
  runtimeBaseline?: unknown,
  pollMode: PollMode = "both",
) {
  const run = canaryId
    ? await readRunById(db, canaryId)
    : await readLatestRun(db, environment, deploymentSha);
  if (!run || run.environment !== environment || run.deployment_sha !== deploymentSha)
    return missingCanaryReport(deploymentSha, environment, nowMs, canaryId ?? null);
  const eligible = nowMs >= Date.parse(run.ends_at);
  const [quota, monitorProgress, invariants] = await Promise.all([
    readQuotaEvidence(run, runtimeQuota, nowMs, environment, {
      finalEvidenceRequired: eligible,
      runtimeStartedAt: run.started_at,
      runtimeEndedAt: run.ends_at,
    }),
    readV2MonitorProgress(db, run.started_at, nowMs),
    readV2CandidateIntegrity(db),
  ]);
  // pollMode remains solely the existing deployment-tag selector. It is read
  // from the deployed environment, never inferred from retired invocation rows.
  const collectorScriptVersion = `${deploymentSha}-${pollMode}-v10`;
  const dispatcherScriptVersion = `${deploymentSha}-v10`;
  const runtime = evaluateForecastRuntimeTelemetry({
    coverageBasis: "scheduled",
    nowMs,
    telemetry: runtimeTelemetry,
    canaryId: run.canary_id,
    deploymentSha,
    collectorScriptVersion,
    dispatcherScriptVersion,
    collectorScriptVersionId: run.collector_version_id,
    dispatcherScriptVersionId: run.dispatcher_version_id,
    startedAt: run.started_at,
    endedAt: run.ends_at,
    collectorExpectedSlots: expectedSlots(Date.parse(run.started_at), Date.parse(run.ends_at), 0),
    dispatcherExpectedSlots: expectedSlots(Date.parse(run.started_at), Date.parse(run.ends_at), 1),
    baseline: runtimeBaseline,
  });
  const decision = evaluateCanaryDecision({
    eligible,
    monitorProgress,
    earlyFailureReasons: [],
    invariants,
    quota,
    runtime,
  });
  return {
    version: 11,
    policyId: FORECAST_CANARY_POLICY_ID,
    canaryId: run.canary_id,
    deploymentSha,
    environment,
    identity: {
      canaryId: run.canary_id,
      deploymentSha,
      collectorScriptVersion,
      dispatcherScriptVersion,
      collectorScriptVersionId: run.collector_version_id,
      dispatcherScriptVersionId: run.dispatcher_version_id,
      startedAt: run.started_at,
      endedAt: run.ends_at,
    },
    pollMode,
    acceptance: {
      windowMode: CANARY_WINDOW_MODE,
      windowHours: CANARY_WINDOW_MS / (60 * 60_000),
      minimumDeliveryRate: CANARY_MINIMUM_DELIVERY_RATE,
      minimumCompletionRate: CANARY_MINIMUM_COMPLETION_RATE,
      maximumMissingSlots: 1,
    },
    window: {
      startedAt: run.started_at,
      endsAt: run.ends_at,
      observedUntil: new Date(Math.min(nowMs, Date.parse(run.ends_at))).toISOString(),
      eligible,
      earlyFailure: false,
      earlyFailureReasons: [],
    },
    monitorProgress,
    quotaEvidence: quota,
    invariants,
    ...decision,
    performance: {
      ...runtime.performance,
      sampleHash: await sha256Hex(stableJson(runtimeTelemetry ?? null)),
    },
  };
}

export async function readCanaryWindow(
  db: D1Database,
  nowMs: number,
  deploymentSha: string,
  environment: Environment = "staging",
  canaryId?: string,
  pollMode: PollMode = "both",
) {
  const row = canaryId
    ? await readRunById(db, canaryId)
    : await readLatestRun(db, environment, deploymentSha);
  const run = row?.environment === environment && row.deployment_sha === deploymentSha ? row : null;
  return {
    version: 11,
    policyId: FORECAST_CANARY_POLICY_ID,
    canaryId: run?.canary_id ?? canaryId ?? null,
    deploymentSha,
    environment,
    collectorVersionId: run?.collector_version_id ?? null,
    dispatcherVersionId: run?.dispatcher_version_id ?? null,
    pollMode: run ? pollMode : "missing",
    acceptance: {
      windowMode: CANARY_WINDOW_MODE,
      windowHours: run ? CANARY_WINDOW_MS / (60 * 60_000) : null,
    },
    window: {
      startedAt: run?.started_at ?? null,
      endsAt: run?.ends_at ?? null,
      observedAt: new Date(nowMs).toISOString(),
      active: Boolean(
        run && Date.parse(run.started_at) <= nowMs && nowMs < Date.parse(run.ends_at),
      ),
      eligible: Boolean(run && nowMs >= Date.parse(run.ends_at)),
    },
  };
}

async function readRunById(db: D1Database, canaryId: string) {
  return db
    .prepare("SELECT * FROM canary_runs WHERE canary_id=?")
    .bind(canaryId)
    .first<CanaryRunRow>();
}

async function readLatestRun(db: D1Database, environment: Environment, deploymentSha: string) {
  return db
    .prepare(`SELECT * FROM canary_runs WHERE environment=? AND deployment_sha=?
      ORDER BY started_at DESC LIMIT 1`)
    .bind(environment, deploymentSha)
    .first<CanaryRunRow>();
}

function expectedSlots(startedMs: number, endsMs: number, minuteRemainder: 0 | 1) {
  const result: string[] = [];
  let cursor = (Math.floor(startedMs / 60_000) + 1) * 60_000;
  while (cursor < endsMs) {
    if (new Date(cursor).getUTCMinutes() % 3 === minuteRemainder)
      result.push(new Date(cursor).toISOString());
    cursor += 60_000;
  }
  return result;
}

function publicRun(row: CanaryRunRow) {
  return {
    canaryId: row.canary_id,
    environment: row.environment,
    deploymentSha: row.deployment_sha,
    collectorCron: row.collector_cron,
    dispatcherCron: row.dispatcher_cron,
    collectorVersionId: row.collector_version_id,
    dispatcherVersionId: row.dispatcher_version_id,
    startedAt: row.started_at,
    endsAt: row.ends_at,
  };
}
