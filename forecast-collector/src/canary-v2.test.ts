import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { FORECAST_CANARY_POLICY_ID } from "../../shared/forecastCanaryRuntime";
import { executeTestSql } from "../../shared/testD1Sql";
import { readCanaryReport, readCanaryWindow, startCanaryDeployment } from "./canary";
import {
  CANARY_ID,
  COLLECTOR_VERSION_ID,
  DISPATCHER_VERSION_ID,
  END,
  quotaEvidence,
  runtimeQuotaEvidence,
  runtimeTelemetry,
  SHA,
  START,
} from "./test-canary-v2-fixture";
import schema from "./test-schema";

function startInput() {
  return {
    environment: "staging" as const,
    canaryId: CANARY_ID,
    deploymentSha: SHA,
    collectorCron: "*/3 * * * *",
    dispatcherCron: "1-59/3 * * * *",
    collectorVersionId: COLLECTOR_VERSION_ID,
    dispatcherVersionId: DISPATCHER_VERSION_ID,
    quotaEvidence: quotaEvidence(START),
    nowMs: START,
  };
}

beforeEach(async () => {
  await reset();
  await executeTestSql(env.FORECAST_DB, schema, applyD1Migrations);
  await startCanaryDeployment(env.FORECAST_DB, startInput());
  await env.FORECAST_DB.prepare(`INSERT INTO forecast_v2_monitor_runs
    (run_id,stream_id,generation,kind,status,started_at,finished_at)
    SELECT 'run-'||stream_id,stream_id,1,'new','completed',?,?
    FROM forecast_v2_monitors WHERE on_demand=0`)
    .bind(new Date(END - 120_000).toISOString(), new Date(END - 60_000).toISOString())
    .run();
  await env.FORECAST_DB.prepare("UPDATE forecast_v2_monitor_state SET updated_at=?")
    .bind(new Date(END - 30_000).toISOString())
    .run();
});

function report(
  telemetry: unknown = runtimeTelemetry(),
  quota: ReturnType<typeof runtimeQuotaEvidence> | undefined = runtimeQuotaEvidence(),
  now = END,
) {
  return readCanaryReport(env.FORECAST_DB, now, SHA, "staging", CANARY_ID, quota, telemetry);
}

it("passes fresh, independently supplied telemetry, monitor progress and quota evidence", async () => {
  const value = await report();
  expect(value.version).toBe(11);
  expect(value.policyId).toBe(FORECAST_CANARY_POLICY_ID);
  expect(value.monitorProgress).toMatchObject({ valid: true, identityBinding: "telemetry-only" });
  expect(value.quotaEvidence.valid).toBe(true);
  expect(value.runtimeSafety.status).toBe("passed");
  expect(value.functional.status).toBe("passed");
  expect(value.certification.status).toBe("passed_with_warning");
  expect(value.performance.collector).toMatchObject({
    coverageBasis: "scheduled",
    expectedSlots: 160,
    d1ObservedSlots: 0,
    telemetryObservedSlots: 160,
  });
  expect(
    await env.FORECAST_DB.prepare("SELECT COUNT(*) n FROM workflow_dispatches").first("n"),
  ).toBe(0);
  expect(
    await env.FORECAST_DB.prepare("SELECT COUNT(*) n FROM collector_invocations").first("n"),
  ).toBe(0);
});

it("rejects legacy-only D1 evidence even with valid scheduled telemetry and quota", async () => {
  await env.FORECAST_DB.prepare("DELETE FROM forecast_v2_monitor_runs").run();
  await env.FORECAST_DB.prepare(`INSERT INTO collector_invocations
    (invocation_id,deployment_sha,scheduled_at,started_at,finished_at,status,poll_mode)
    VALUES('legacy',?,?,?,?,'completed','both')`)
    .bind(
      SHA,
      new Date(END - 60_000).toISOString(),
      new Date(END - 60_000).toISOString(),
      new Date(END).toISOString(),
    )
    .run();
  const value = await report();
  expect(value.monitorProgress.valid).toBe(false);
  expect(value.monitorProgress.failureCodes).toContain("v2_monitor_progress_missing:A");
  expect(value.certification.status).toBe("incomplete");
});

it.each(["old-format", "skipped"])("keeps %s collector telemetry incomplete", async (admission) => {
  const telemetry = runtimeTelemetry();
  const collector = telemetry.workers.find((worker) => worker.component === "collector");
  if (!collector) throw new Error("fixture_missing");
  for (const sample of collector.samples) {
    if (admission === "old-format") {
      delete sample.mode;
      delete sample.admission;
    } else {
      sample.admission = "skipped";
    }
  }

  const value = await report(telemetry);

  expect(value.evidence.status).toBe("incomplete");
  expect(value.evidence.errors).toContain("runtime_telemetry_coverage_incomplete:collector");
  expect(value.runtimeSafety.status).toBe("incomplete");
  expect(value.certification.status).toBe("incomplete");
  expect(value.performance.collector).toMatchObject({ telemetryObservedSlots: 0 });
});

it.each(["running", "held"])("blocks unfinished latest monitor state %s", async (status) => {
  await env.FORECAST_DB.prepare("UPDATE forecast_v2_monitor_runs SET status=? WHERE stream_id='A'")
    .bind(status)
    .run();
  expect((await report()).monitorProgress.failureCodes).toContain("v2_monitor_progress_missing:A");
});

it("keeps a pre-start failed latest run incomplete instead of attributing it to this canary", async () => {
  await env.FORECAST_DB.prepare(
    "UPDATE forecast_v2_monitor_runs SET status='failed',started_at='2000-01-01T00:00:00Z',finished_at='2000-01-01T00:01:00Z' WHERE stream_id='A'",
  ).run();
  const value = await report();
  expect(value.certification.status).toBe("incomplete");
  expect(value.monitorProgress.failureCodes).toContain("v2_monitor_run_stale_or_invalid:A");
  expect(value.monitorProgress.failureCodes).not.toContain("v2_monitor_run_failed:A");
});

it.each([true, false])(
  "fails on an observed failed monitor even with telemetry=%s",
  async (present) => {
    await env.FORECAST_DB.prepare(
      "UPDATE forecast_v2_monitor_runs SET status='failed' WHERE stream_id='A'",
    ).run();
    const value = await report(present ? runtimeTelemetry() : null);
    expect(value.functional.status).toBe("failed");
    expect(value.certification.status).toBe("failed");
    expect(value.certification.hardFailures).toContain("v2_monitor_run_failed:A");
  },
);

it.each([
  [
    "UPDATE forecast_v2_monitor_state SET updated_at='2000-01-01T00:00:00Z' WHERE stream_id='A'",
    "v2_monitor_heartbeat_stale_or_invalid:A",
  ],
  [
    "UPDATE forecast_v2_monitor_runs SET started_at='2000-01-01T00:00:00Z',finished_at='2000-01-01T00:01:00Z' WHERE stream_id='A'",
    "v2_monitor_run_stale_or_invalid:A",
  ],
  [
    "UPDATE forecast_v2_monitors SET interval_seconds=86400 WHERE stream_id='A'",
    "v2_monitor_definition_mismatch:A",
  ],
  [
    "DELETE FROM forecast_v2_monitor_state WHERE stream_id='A'",
    "v2_monitor_heartbeat_stale_or_invalid:A",
  ],
  [
    "DELETE FROM forecast_v2_monitor_state WHERE stream_id='E'",
    "v2_monitor_heartbeat_stale_or_invalid:E",
  ],
])("blocks invalid progress: %s", async (sql, failure) => {
  await env.FORECAST_DB.prepare(sql).run();
  const value = await report();
  expect(value.monitorProgress.failureCodes).toContain(failure);
  expect(value.runtimeSafety.status).toBe("passed");
  expect(value.quotaEvidence.valid).toBe(true);
  expect(value.certification.status).toBe("incomplete");
});

it("does not require on-demand E to fabricate a run when it has no work", async () => {
  expect(
    await env.FORECAST_DB.prepare(
      "SELECT COUNT(*) n FROM forecast_v2_monitor_runs WHERE stream_id='E'",
    ).first("n"),
  ).toBe(0);
  expect((await report()).monitorProgress.valid).toBe(true);
});

it("blocks missing telemetry independently of fresh D1 and quota", async () => {
  const value = await report(null);
  expect(value.monitorProgress.valid).toBe(true);
  expect(value.quotaEvidence.valid).toBe(true);
  expect(value.evidence.status).toBe("incomplete");
  expect(value.certification.status).toBe("incomplete");
});

it("blocks stale telemetry independently of fresh D1 and quota", async () => {
  const value = await report(runtimeTelemetry(), runtimeQuotaEvidence(), END + 240_000);
  expect(value.monitorProgress.valid).toBe(true);
  expect(value.quotaEvidence.valid).toBe(true);
  expect(value.evidence.errors).toContain("runtime_observation_stale_or_future");
});

it("blocks mismatched deployed-version metadata", async () => {
  const telemetry = runtimeTelemetry();
  telemetry.collectorScriptVersionId = DISPATCHER_VERSION_ID;
  const value = await report(telemetry);
  expect(value.monitorProgress.valid).toBe(true);
  expect(value.evidence.errors).toContain("runtime_collector_version_id_identity_mismatch");
});

it("rejects marker-only identity even when CPU summaries are present", async () => {
  const telemetry = runtimeTelemetry();
  for (const worker of telemetry.workers)
    for (const sample of worker.samples) {
      sample.scriptVersionId = null;
      sample.scriptVersionTag = null;
      sample.identitySource = "marker";
    }
  const value = await report(telemetry);
  expect(value.evidence.errors).toContain("runtime_version_metadata_missing:collector");
  expect(value.certification.status).toBe("incomplete");
});

it("blocks missing or stale quota independently of valid telemetry and monitors", async () => {
  const missing = await readCanaryReport(
    env.FORECAST_DB,
    END,
    SHA,
    "staging",
    CANARY_ID,
    undefined,
    runtimeTelemetry(),
  );
  expect(missing.monitorProgress.valid).toBe(true);
  expect(missing.runtimeSafety.status).toBe("passed");
  expect(missing.quotaEvidence.valid).toBe(false);
  const quota = runtimeQuotaEvidence();
  quota.observedAt = new Date(START).toISOString();
  expect((await report(runtimeTelemetry(), quota)).quotaEvidence.valid).toBe(false);
});

it("preserves immutable canary identity and reports the deployed tag selector", async () => {
  expect((await startCanaryDeployment(env.FORECAST_DB, startInput())).canaryId).toBe(CANARY_ID);
  await expect(
    startCanaryDeployment(env.FORECAST_DB, {
      ...startInput(),
      collectorVersionId: DISPATCHER_VERSION_ID,
    }),
  ).rejects.toThrow("canary_run_conflict");
  const window = await readCanaryWindow(env.FORECAST_DB, END, SHA, "staging", CANARY_ID);
  expect(window).toMatchObject({ version: 11, pollMode: "both", window: { eligible: true } });
});

it("blocks a mismatched billing period or Usage Guard action", async () => {
  const period = runtimeQuotaEvidence();
  period.periodEnd = "2026-10-15T00:00:00.000Z";
  expect((await report(runtimeTelemetry(), period)).quotaEvidence.errorCode).toBe(
    "cloudflare_paid_billing_period_changed",
  );
  const guard = runtimeQuotaEvidence();
  guard.action = "hard_stop";
  const value = await report(runtimeTelemetry(), guard);
  expect(value.monitorProgress.valid).toBe(true);
  expect(value.runtimeSafety.status).toBe("passed");
  expect(value.quotaEvidence.errorCode).toBe("cloudflare_paid_guard_action_mismatch");
  const window = runtimeQuotaEvidence();
  window.evidence.workerRuntime.endedAt = new Date(END - 60_000).toISOString();
  expect((await report(runtimeTelemetry(), window)).quotaEvidence.errorCode).toBe(
    "cloudflare_paid_runtime_window_mismatch",
  );
});

it("blocks an invalid quota observation timestamp", async () => {
  const quota = runtimeQuotaEvidence();
  quota.observedAt = "not-a-timestamp";
  expect((await report(runtimeTelemetry(), quota)).quotaEvidence.valid).toBe(false);
});

it("allows a quiet Router without inventing a runtime quota row", async () => {
  const quota = runtimeQuotaEvidence();
  quota.evidence.workerRuntime.workers = quota.evidence.workerRuntime.workers.filter(
    (worker) => worker.scriptName !== "collection-kit-forecast-interactions-staging",
  );
  expect((await report(runtimeTelemetry(), quota)).quota.status).toBe("passed");
});

it("does not fabricate missing account diagnostics from scheduled logs", async () => {
  const quota = runtimeQuotaEvidence();
  quota.evidence.workerRuntime.workers = quota.evidence.workerRuntime.workers.filter(
    (worker) => worker.scriptName !== "collection-kit-forecast-dispatcher-staging",
  );
  const value = await report(runtimeTelemetry(), quota);
  expect(value.runtimeSafety.status).toBe("passed");
  expect(value.monitorProgress.valid).toBe(true);
  expect(value.quotaEvidence.accountRuntime?.missingWorkers).toContain(
    "collection-kit-forecast-dispatcher-staging",
  );
  expect(value.quota.status).toBe("passed");
  expect(value.certification.status).toBe("passed_with_warning");
});

it("keeps mixed GraphQL runtime diagnostics out of the scheduled-only hard gate", async () => {
  const quota = runtimeQuotaEvidence();
  const collector = quota.evidence.workerRuntime.workers.find(
    (worker) => worker.scriptName === "collection-kit-forecast-collector-staging",
  );
  if (!collector) throw new Error("fixture_missing");
  collector.errorsObserved = 1;
  const value = await report(runtimeTelemetry(), quota);
  expect(value.quotaEvidence.accountRuntime?.status).toBe("failed");
  expect(value.runtimeSafety.status).toBe("passed");
  expect(value.quota.status).toBe("passed");
  expect(value.certification.status).toBe("passed_with_warning");
});

it("rejects stale start evidence and a window crossing the billing period", async () => {
  const id = `fc-${"b".repeat(32)}`;
  await expect(
    startCanaryDeployment(env.FORECAST_DB, {
      ...startInput(),
      canaryId: id,
      quotaEvidence: quotaEvidence(START - 21 * 60_000),
    }),
  ).rejects.toThrow("cloudflare_paid_quota_evidence_stale");
  const late = Date.parse("2026-09-14T20:00:00Z");
  await expect(
    startCanaryDeployment(env.FORECAST_DB, {
      ...startInput(),
      canaryId: id,
      quotaEvidence: quotaEvidence(late),
      nowMs: late,
    }),
  ).rejects.toThrow("canary_crosses_cloudflare_billing_period");
});

it("keeps retries immutable and permits a later independent run for the same SHA", async () => {
  expect(await startCanaryDeployment(env.FORECAST_DB, startInput())).toMatchObject({
    startedAt: new Date(START).toISOString(),
    endsAt: new Date(END).toISOString(),
  });
  const nextStart = END + 60_000;
  const id = `fc-${"b".repeat(32)}`;
  await startCanaryDeployment(env.FORECAST_DB, {
    ...startInput(),
    canaryId: id,
    nowMs: nextStart,
    quotaEvidence: quotaEvidence(nextStart),
  });
  expect(await readCanaryWindow(env.FORECAST_DB, nextStart, SHA)).toMatchObject({
    canaryId: id,
    window: { startedAt: new Date(nextStart).toISOString(), active: true },
  });
  expect(
    await readCanaryWindow(env.FORECAST_DB, nextStart, SHA, "staging", CANARY_ID),
  ).toMatchObject({ canaryId: CANARY_ID, window: { eligible: true } });
});
