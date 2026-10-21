import { expect } from "vitest";
import {
  type CloudflarePaidUsageSnapshot,
  evaluateD1PreflightBudget,
} from "../../shared/cloudflarePaidUsage";
import {
  CLOUDFLARE_PAID_INCLUDED_LIMITS,
  CLOUDFLARE_PAID_THRESHOLDS,
  D1_DATABASE_IDS,
  type D1QuotaEvidence,
} from "../../shared/d1QuotaEvidence";
import type { UsageGuardEnv } from "./types";
import { recordSuccessfulEvaluation } from "./worker";

/** Shared Usage Guard test fixtures: evaluated observations and run-row helpers. */
export function usageGuardFixtures(testEnv: UsageGuardEnv, now: number) {
  function observation(
    action: D1QuotaEvidence["action"],
    capturedAt: number,
    periodStart = "2026-08-15T00:00:00.000Z",
    periodEnd = periodStart === "2026-08-15T00:00:00.000Z"
      ? "2026-09-15T00:00:00.000Z"
      : "2026-10-15T00:00:00.000Z",
  ) {
    const percentages = {
      normal: 0,
      warning: CLOUDFLARE_PAID_THRESHOLDS.warningPercent,
      disable_staging: CLOUDFLARE_PAID_THRESHOLDS.disableStagingPercent,
      disable_forecast_production: CLOUDFLARE_PAID_THRESHOLDS.disableForecastProductionPercent,
      disable_statistics_writes: CLOUDFLARE_PAID_THRESHOLDS.disableStatisticsWritesPercent,
      hard_stop: CLOUDFLARE_PAID_THRESHOLDS.hardStopPercent,
    };
    const snapshot: CloudflarePaidUsageSnapshot = {
      version: 2,
      source: "cloudflare-paid-account-analytics-v2",
      accountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      capturedAt: new Date(capturedAt).toISOString(),
      plan: {
        id: "workers-paid",
        verified: true,
        state: "Paid",
        frequency: "monthly",
        periodStart,
        periodEnd,
        subscriptionId: "local-subscription",
        ratePlanId: "workers-paid",
      },
      daily: [],
      databases: Object.values(D1_DATABASE_IDS).map((databaseId, index) => ({
        databaseId,
        databaseName: `local-quota-${index}`,
        rowsReadObserved: 0,
        rowsWrittenObserved: 0,
        // Preflight storage projects observed usage by the safety factor, even without growth.
        storageBytesObserved:
          index === 0
            ? (CLOUDFLARE_PAID_INCLUDED_LIMITS.d1StorageBytes * percentages[action]) /
              (100 * CLOUDFLARE_PAID_THRESHOLDS.safetyFactor)
            : 0,
      })),
      workers: [],
      workerRuntime: {
        startedAt: new Date(capturedAt - 30 * 60_000).toISOString(),
        endedAt: new Date(capturedAt).toISOString(),
        workers: [],
      },
    };
    const evaluation = evaluateD1PreflightBudget(snapshot);
    if (!evaluation.evidence) throw new Error("test_evidence_missing");
    expect(evaluation.evidence.utilization.currentPercent).toBe(
      percentages[action] / CLOUDFLARE_PAID_THRESHOLDS.safetyFactor,
    );
    expect(evaluation.evidence.utilization.projectedPercent).toBe(percentages[action]);
    expect(evaluation.action).toBe(action);
    return { snapshot, evaluation, evidence: evaluation.evidence };
  }

  async function recordSample(
    runId: string,
    sample: ReturnType<typeof observation>,
    guardEnv: UsageGuardEnv = { ...testEnv, DISCORD_BOT_TOKEN: "" },
  ) {
    await recordSuccessfulEvaluation(
      guardEnv,
      sample.snapshot,
      sample.evaluation,
      sample.evidence,
      runId,
    );
  }

  async function reserveTestRun(runId: string) {
    await testEnv.GUARD_DB.prepare(
      `INSERT INTO usage_guard_runs (
         run_id, scheduled_at, started_at, status, deployment_sha
       ) VALUES (?, ?, ?, 'running', ?)`,
    )
      .bind(runId, new Date(now).toISOString(), new Date(now).toISOString(), testEnv.DEPLOY_SHA)
      .run();
  }

  async function storedRun(runId: string) {
    return testEnv.GUARD_DB.prepare("SELECT * FROM usage_guard_runs WHERE run_id = ?")
      .bind(runId)
      .first<Record<string, unknown>>();
  }

  return { observation, recordSample, reserveTestRun, storedRun };
}
