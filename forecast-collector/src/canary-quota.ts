import {
  assertD1QuotaEvidence,
  CLOUDFLARE_PAID_THRESHOLDS,
  type D1QuotaEvidence,
} from "../../shared/d1QuotaEvidence";
import type { UsageGuardEvidence, UsageGuardState } from "../../shared/usageGuard";
import { sha256Hex } from "./crypto";

export const CANARY_WINDOW_MS = CLOUDFLARE_PAID_THRESHOLDS.canaryHours * 60 * 60 * 1_000;

const QUOTA_EVIDENCE_MAX_AGE_MS = 20 * 60 * 1_000;
const WORKER_CPU_LIMITS_MS: Record<string, number> = {
  "collection-kit-stats": 10,
  "collection-kit-stats-staging": 10,
  "collection-kit-forecast-interactions": 10,
  "collection-kit-forecast-dispatcher": 25,
  "collection-kit-forecast-dispatcher-staging": 25,
  "collection-kit-forecast-collector": 50,
  "collection-kit-forecast-collector-staging": 50,
  "collection-kit-usage-guard": 25,
};

type Environment = "staging" | "production";

type StoredQuotaEvidence = {
  quota_evidence_json: string;
  quota_evidence_hash: string;
};

export async function readQuotaEvidence(
  row: StoredQuotaEvidence,
  runtimeQuota: UsageGuardEvidence | UsageGuardState | undefined,
  nowMs: number,
  environment: Environment,
  options: {
    finalEvidenceRequired: boolean;
    runtimeStartedAt: string;
    runtimeEndedAt: string;
  },
) {
  try {
    const evidence = await validateQuotaEvidence(row, runtimeQuota, nowMs, options);
    const cpu = cpuBudgetSummary(evidence, environment);
    if (!cpu.passed) throw new Error(`cloudflare_paid_cpu_budget:${cpu.failureCodes.join(",")}`);
    return {
      valid: true,
      errorCode: null,
      evidence,
      evidenceHash: runtimeQuota?.evidenceHash ?? row.quota_evidence_hash,
      initialEvidenceHash: row.quota_evidence_hash,
      freshnessMinutes: runtimeQuota
        ? Math.max(0, (nowMs - Date.parse(runtimeQuota.observedAt)) / 60_000)
        : null,
      cpu,
    };
  } catch (error) {
    return {
      valid: false,
      errorCode: error instanceof Error ? error.message.slice(0, 120) : "d1_quota_evidence_invalid",
      evidence: null,
      evidenceHash: runtimeQuota?.evidenceHash ?? row.quota_evidence_hash,
      initialEvidenceHash: row.quota_evidence_hash,
      freshnessMinutes: null,
      cpu: null,
    };
  }
}

async function validateQuotaEvidence(
  row: StoredQuotaEvidence,
  runtimeQuota: UsageGuardEvidence | UsageGuardState | undefined,
  nowMs: number,
  options: {
    finalEvidenceRequired: boolean;
    runtimeStartedAt: string;
    runtimeEndedAt: string;
  },
) {
  const actualHash = await sha256Hex(row.quota_evidence_json);
  if (actualHash !== row.quota_evidence_hash) {
    throw new Error("d1_quota_evidence_hash_mismatch");
  }
  const initialEvidence = assertD1QuotaEvidence(JSON.parse(row.quota_evidence_json));
  const runtimeEvidence = runtimeQuota && "evidence" in runtimeQuota ? runtimeQuota.evidence : null;
  if (options.finalEvidenceRequired && !runtimeEvidence) {
    throw new Error("cloudflare_paid_final_evidence_required");
  }
  const evidence = runtimeEvidence ?? initialEvidence;
  if (
    runtimeQuota &&
    (runtimeQuota.periodStart !== initialEvidence.plan.periodStart ||
      runtimeQuota.periodEnd !== initialEvidence.plan.periodEnd)
  ) {
    throw new Error("cloudflare_paid_billing_period_changed");
  }
  assertSameBillingPeriod(initialEvidence, evidence);
  assertRuntimeQuotaFresh(runtimeQuota, evidence, nowMs);
  assertNormalQuota(evidence);
  if (
    runtimeEvidence &&
    (evidence.workerRuntime.startedAt !== options.runtimeStartedAt ||
      evidence.workerRuntime.endedAt !== options.runtimeEndedAt)
  ) {
    throw new Error("cloudflare_paid_runtime_window_mismatch");
  }
  return evidence;
}

export function assertCanaryStartWindow(nowMs: number, evidence: D1QuotaEvidence) {
  assertQuotaEvidenceFresh(evidence, nowMs);
  assertNormalQuota(evidence);
  assertRollingRuntimeEvidence(evidence);
  if (
    Date.parse(evidence.plan.periodStart) > nowMs ||
    Date.parse(evidence.plan.periodEnd) < nowMs + CANARY_WINDOW_MS
  ) {
    throw new Error("canary_crosses_cloudflare_billing_period");
  }
}

function assertRollingRuntimeEvidence(evidence: D1QuotaEvidence) {
  const observedAt = Date.parse(evidence.observedAt);
  const expectedStart = Math.max(
    Date.parse(evidence.plan.periodStart),
    observedAt - CANARY_WINDOW_MS,
  );
  if (
    Date.parse(evidence.workerRuntime.startedAt) !== expectedStart ||
    Date.parse(evidence.workerRuntime.endedAt) !== observedAt
  ) {
    throw new Error("cloudflare_paid_canary_start_runtime_invalid");
  }
}

function cpuBudgetSummary(evidence: D1QuotaEvidence, environment: Environment) {
  const required = requiredWorkerNames(environment);
  const workers = evidence.workerRuntime.workers
    .filter((worker) => worker.scriptName in WORKER_CPU_LIMITS_MS)
    .map((worker) => {
      const configuredLimitMs = WORKER_CPU_LIMITS_MS[worker.scriptName] ?? 0;
      return {
        scriptName: worker.scriptName,
        configuredLimitMs,
        allowedP99Ms: configuredLimitMs * 0.8,
        cpuTimeAverageMs: worker.cpuTimeAverageMs,
        cpuTimeP95Ms: worker.cpuTimeP95Ms,
        cpuTimeP99Ms: worker.cpuTimeP99Ms,
        exceededCpuObserved: worker.exceededCpuObserved,
        passed:
          configuredLimitMs > 0 &&
          worker.cpuTimeP99Ms < configuredLimitMs * 0.8 &&
          worker.exceededCpuObserved === 0,
      };
    });
  const names = new Set(workers.map((worker) => worker.scriptName));
  const missingWorkers = required.filter((scriptName) => !names.has(scriptName));
  const failureCodes = [
    ...missingWorkers.map((scriptName) => `missing:${scriptName}`),
    ...workers.filter((worker) => !worker.passed).map((worker) => `cpu:${worker.scriptName}`),
  ];
  return { workers, missingWorkers, failureCodes, passed: failureCodes.length === 0 };
}

function requiredWorkerNames(environment: Environment) {
  const forecastSuffix = environment === "staging" ? "-staging" : "";
  return [
    `collection-kit-forecast-collector${forecastSuffix}`,
    `collection-kit-forecast-dispatcher${forecastSuffix}`,
    "collection-kit-forecast-interactions",
    "collection-kit-usage-guard",
  ];
}

function assertSameBillingPeriod(initial: D1QuotaEvidence, current: D1QuotaEvidence) {
  if (
    current.plan.periodStart !== initial.plan.periodStart ||
    current.plan.periodEnd !== initial.plan.periodEnd
  ) {
    throw new Error("cloudflare_paid_billing_period_changed");
  }
}

function assertRuntimeQuotaFresh(
  runtimeQuota: UsageGuardEvidence | UsageGuardState | undefined,
  evidence: D1QuotaEvidence,
  nowMs: number,
) {
  if (!runtimeQuota) return;
  if (runtimeQuota.action !== "normal") {
    throw new Error(`cloudflare_paid_guard_${runtimeQuota.action}`);
  }
  assertObservedAtFresh(runtimeQuota.observedAt, nowMs);
  if ("evidence" in runtimeQuota) assertQuotaEvidenceFresh(evidence, nowMs);
}

function assertObservedAtFresh(observedAtValue: string, nowMs: number) {
  const observedAt = Date.parse(observedAtValue);
  if (observedAt > nowMs + 60_000 || nowMs - observedAt > QUOTA_EVIDENCE_MAX_AGE_MS) {
    throw new Error("cloudflare_paid_quota_evidence_stale");
  }
}

function assertQuotaEvidenceFresh(evidence: D1QuotaEvidence, nowMs: number) {
  const observedAt = Date.parse(evidence.observedAt);
  if (observedAt > nowMs + 60_000 || nowMs - observedAt > QUOTA_EVIDENCE_MAX_AGE_MS) {
    throw new Error("cloudflare_paid_quota_evidence_stale");
  }
}

function assertNormalQuota(evidence: D1QuotaEvidence) {
  if (
    !evidence.passed ||
    evidence.action !== "normal" ||
    evidence.utilization.currentPercent >= CLOUDFLARE_PAID_THRESHOLDS.warningPercent ||
    evidence.utilization.projectedPercent >= CLOUDFLARE_PAID_THRESHOLDS.warningPercent
  ) {
    throw new Error("cloudflare_paid_quota_not_normal");
  }
}
