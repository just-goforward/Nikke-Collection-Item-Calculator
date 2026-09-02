import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildMetricEvidence,
  CLOUDFLARE_PAID_INCLUDED_LIMITS,
  CLOUDFLARE_PAID_THRESHOLDS,
  D1_DATABASE_IDS,
  type D1QuotaEvidence,
} from "../../shared/d1QuotaEvidence";
import schemaSql from "../schema.sql?raw";
import { readCanaryReport, readCanaryWindow, startCanaryDeployment } from "./canary";
import type { CollectorEnv } from "./types";

const testEnv: CollectorEnv = {
  FORECAST_DB: env.FORECAST_DB,
  ADMIN_RATE_LIMITER: env.ADMIN_RATE_LIMITER,
  ADMIN_TOKEN: env.ADMIN_TOKEN,
  ENVIRONMENT: "test",
  DEPLOY_SHA: env.DEPLOY_SHA,
  POLL_MODE: "both",
};
const SHA = "a".repeat(40);
const CANARY_ID = `fc-${"a".repeat(32)}`;
const START = Date.parse("2026-09-01T02:00:30.000Z");
const END = START + 8 * 60 * 60 * 1_000;

beforeEach(async () => {
  await reset();
  for (const statement of schemaSql
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    await testEnv.FORECAST_DB.prepare(statement).run();
  }
  await startCanaryDeployment(testEnv.FORECAST_DB, {
    environment: "staging",
    canaryId: CANARY_ID,
    deploymentSha: SHA,
    collectorCron: "*/3 * * * *",
    dispatcherCron: "1-59/3 * * * *",
    quotaEvidence: quotaEvidence(START),
    nowMs: START,
  });
  await insertSmokeAndRouterTest();
});

describe("canary report v7 storage and start contract", () => {
  it("uses covering indexes for the recurring latest-invocation queries", async () => {
    const collectorPlan = await testEnv.FORECAST_DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT status, next_retry_at FROM collector_invocations
       WHERE status <> 'running' ORDER BY scheduled_at DESC LIMIT 12`,
    ).all<{ detail: string }>();
    const dispatcherPlan = await testEnv.FORECAST_DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT status, error_code FROM dispatcher_invocations
       WHERE environment = 'staging' ORDER BY scheduled_at DESC LIMIT 1`,
    ).all<{ detail: string }>();

    expect(collectorPlan.results.map((row) => row.detail).join("\n")).toContain(
      "collector_invocations_latest_idx",
    );
    expect(dispatcherPlan.results.map((row) => row.detail).join("\n")).toContain(
      "dispatcher_invocations_environment_latest_idx",
    );
  });

  it("passes a fixed eight-hour certificate", async () => {
    const collectorSlots = slots(0);
    const dispatcherSlots = slots(1);
    expect(collectorSlots).toHaveLength(160);
    expect(dispatcherSlots).toHaveLength(160);
    await insertInvocationSlots("collector", collectorSlots);
    await insertInvocationSlots("dispatcher", dispatcherSlots);

    const report = await readFinalCanaryReport();

    expect(report.version).toBe(7);
    expect(report.canaryId).toBe(CANARY_ID);
    expect(report.acceptance).toMatchObject({ windowMode: "fixed_8_hours", windowHours: 8 });
    expect(report.quota).toMatchObject({ valid: true, errorCode: null });
    expect(report.window).toMatchObject({
      endsAt: "2026-09-01T10:00:30.000Z",
      eligible: true,
      earlyFailure: false,
    });
    expect(report.collector).toMatchObject({
      expectedSlots: collectorSlots.length,
      observedSlots: collectorSlots.length,
      missingSlots: 0,
      deliveryRate: 1,
      completionRate: 1,
    });
    expect(report.dispatcher).toMatchObject({
      expectedSlots: dispatcherSlots.length,
      observedSlots: dispatcherSlots.length,
      smokeCount: 1,
      duplicateDispatches: 0,
      duplicateRuns: 0,
    });
    expect(report.router).toMatchObject({
      routerTestCount: 1,
      maxInitialResponseMs: 75,
      duplicateInteractions: 0,
    });
    expect(report.invariants.totalInvalid).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("reads canary timing without building the full report", async () => {
    const active = await readCanaryWindow(
      testEnv.FORECAST_DB,
      START + 60 * 60 * 1_000,
      SHA,
      "staging",
    );
    expect(active).toMatchObject({
      version: 7,
      canaryId: CANARY_ID,
      acceptance: { windowMode: "fixed_8_hours", windowHours: 8 },
      window: { active: true, eligible: false },
    });

    const eligible = await readCanaryWindow(testEnv.FORECAST_DB, END, SHA, "staging");
    expect(eligible.window).toMatchObject({ active: false, eligible: true });
  });

  it("keeps retries idempotent and permits a later independent run for the same SHA", async () => {
    const retry = await startCanaryDeployment(testEnv.FORECAST_DB, {
      environment: "staging",
      canaryId: CANARY_ID,
      deploymentSha: SHA,
      collectorCron: "*/3 * * * *",
      dispatcherCron: "1-59/3 * * * *",
      quotaEvidence: quotaEvidence(START),
      nowMs: START + 60_000,
    });
    expect(retry.canaryId).toBe(CANARY_ID);

    await expect(
      startCanaryDeployment(testEnv.FORECAST_DB, {
        environment: "staging",
        canaryId: `fc-${"e".repeat(32)}`,
        deploymentSha: SHA,
        collectorCron: "*/3 * * * *",
        dispatcherCron: "1-59/3 * * * *",
        quotaEvidence: quotaEvidence(START),
        nowMs: START + 60_000,
      }),
    ).rejects.toThrow("canary_run_overlap");

    const nextStart = START + 24 * 60 * 60 * 1_000;
    const next = await startCanaryDeployment(testEnv.FORECAST_DB, {
      environment: "staging",
      canaryId: `fc-${"b".repeat(32)}`,
      deploymentSha: SHA,
      collectorCron: "*/3 * * * *",
      dispatcherCron: "1-59/3 * * * *",
      quotaEvidence: quotaEvidence(nextStart),
      nowMs: nextStart,
    });
    expect(next.canaryId).not.toBe(CANARY_ID);
  });

  it("requires exact-window CPU evidence for an eligible certificate", async () => {
    const withoutEvidence = await readCanaryReport(testEnv.FORECAST_DB, END, SHA, "staging");
    expect(withoutEvidence.quota).toMatchObject({
      valid: false,
      errorCode: "cloudflare_paid_final_evidence_required",
    });

    const mismatchedEvidence = runtimeQuotaEvidence(START + 60_000, END);
    const mismatched = await readCanaryReport(
      testEnv.FORECAST_DB,
      END,
      SHA,
      "staging",
      undefined,
      mismatchedEvidence,
    );
    expect(mismatched.quota).toMatchObject({
      valid: false,
      errorCode: "cloudflare_paid_runtime_window_mismatch",
    });
  });

  it("rejects stale evidence and a canary crossing the billing period", async () => {
    await expect(
      startCanaryDeployment(testEnv.FORECAST_DB, {
        environment: "production",
        canaryId: `fc-${"c".repeat(32)}`,
        deploymentSha: SHA,
        collectorCron: "*/3 * * * *",
        dispatcherCron: "1-59/3 * * * *",
        quotaEvidence: quotaEvidence(START - 21 * 60_000),
        nowMs: START,
      }),
    ).rejects.toThrow("cloudflare_paid_quota_evidence_stale");

    const outsideWindow = Date.parse("2026-09-14T20:00:30.000Z");
    await expect(
      startCanaryDeployment(testEnv.FORECAST_DB, {
        environment: "production",
        canaryId: `fc-${"d".repeat(32)}`,
        deploymentSha: SHA,
        collectorCron: "*/3 * * * *",
        dispatcherCron: "1-59/3 * * * *",
        quotaEvidence: quotaEvidence(outsideWindow),
        nowMs: outsideWindow,
      }),
    ).rejects.toThrow("canary_crosses_cloudflare_billing_period");
  });
});

describe("canary report v7 slot evidence", () => {
  it("allows one missing slot but rejects two", async () => {
    const collector = slots(0);
    const dispatcher = slots(1);
    await insertInvocationSlots("collector", collector.slice(1));
    await insertInvocationSlots("dispatcher", dispatcher.slice(0, -1));

    const oneMissing = await readFinalCanaryReport();
    expect(oneMissing.collector).toMatchObject({
      expectedSlots: collector.length,
      observedSlots: collector.length - 1,
      missingSlots: 1,
    });
    expect(oneMissing.dispatcher).toMatchObject({
      expectedSlots: dispatcher.length,
      observedSlots: dispatcher.length - 1,
      missingSlots: 1,
    });
    expect(oneMissing.passed).toBe(true);

    await testEnv.FORECAST_DB.prepare("DELETE FROM collector_invocations WHERE scheduled_at = ?")
      .bind(collector[1])
      .run();
    const twoMissing = await readFinalCanaryReport();
    expect(twoMissing.collector).toMatchObject({
      observedSlots: collector.length - 2,
      missingSlots: 2,
    });
    expect(twoMissing.passed).toBe(false);
  });

  it("fails early after two hours for material delivery loss", async () => {
    const twoHours = START + 2 * 60 * 60 * 1_000;
    const collector = slots(0).filter((value) => Date.parse(value) < twoHours);
    const dispatcher = slots(1).filter((value) => Date.parse(value) < twoHours);
    await insertInvocationSlots("collector", collector.slice(3));
    await insertInvocationSlots("dispatcher", dispatcher);

    const report = await readCanaryReport(testEnv.FORECAST_DB, twoHours, SHA, "staging");

    expect(report.window.eligible).toBe(false);
    expect(report.window.earlyFailure).toBe(true);
    expect(report.window.earlyFailureReasons).toContain("collector_missing_slots_over_5_percent");
    expect(report.passed).toBe(false);
  });

  it("rejects an invocation that does not belong to an expected Cron slot", async () => {
    await insertInvocationSlots("collector", slots(0));
    await insertInvocationSlots("dispatcher", slots(1));
    const unexpected = new Date(START + 2 * 60_000).toISOString();
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO collector_invocations (
         invocation_id, deployment_sha, scheduled_at, started_at, finished_at, status, poll_mode
       ) VALUES ('collector-unexpected', ?, ?, ?, ?, 'completed', 'both')`,
    )
      .bind(SHA, unexpected, unexpected, unexpected)
      .run();

    const report = await readFinalCanaryReport();

    expect(report.collector.unexpectedInvocations).toBe(1);
    expect(report.passed).toBe(false);
  });

  it("rejects duplicate, abandoned, and post-window invocation evidence", async () => {
    const collector = slots(0);
    await insertInvocationSlots("collector", collector);
    await insertInvocationSlots("dispatcher", slots(1));
    const duplicateSlot = collector[0];
    if (!duplicateSlot) throw new Error("missing_duplicate_fixture_slot");
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO collector_invocations (
         invocation_id, deployment_sha, scheduled_at, started_at, finished_at, status, poll_mode
       ) VALUES ('collector-duplicate', ?, ?, ?, ?, 'completed', 'both')`,
    )
      .bind(SHA, duplicateSlot, duplicateSlot, duplicateSlot)
      .run();
    await testEnv.FORECAST_DB.prepare(
      `UPDATE collector_invocations
       SET status = 'running', finished_at = NULL WHERE invocation_id = 'collector-1'`,
    ).run();
    await testEnv.FORECAST_DB.prepare(
      `UPDATE collector_invocations
       SET started_at = ? WHERE invocation_id = 'collector-2'`,
    )
      .bind(new Date(END).toISOString())
      .run();

    const report = await readFinalCanaryReport();

    expect(report.collector).toMatchObject({
      duplicateInvocations: 1,
      abandoned: 1,
      lateInvocations: 1,
    });
    expect(report.passed).toBe(false);
  });
});

function slots(remainder: 0 | 1) {
  const values: string[] = [];
  for (let cursor = Math.floor(START / 60_000) * 60_000 + 60_000; cursor < END; cursor += 60_000) {
    if (new Date(cursor).getUTCMinutes() % 3 === remainder) {
      values.push(new Date(cursor).toISOString());
    }
  }
  return values;
}

async function insertInvocationSlots(kind: "collector" | "dispatcher", values: string[]) {
  const statements = values.map((scheduledAt, index) => {
    if (kind === "collector") {
      return testEnv.FORECAST_DB.prepare(
        `INSERT INTO collector_invocations (
           invocation_id, deployment_sha, scheduled_at, started_at, finished_at,
           status, poll_mode
         ) VALUES (?, ?, ?, ?, ?, 'completed', 'both')`,
      ).bind(`collector-${index}`, SHA, scheduledAt, scheduledAt, scheduledAt);
    }
    return testEnv.FORECAST_DB.prepare(
      `INSERT INTO dispatcher_invocations (
         invocation_id, deployment_sha, environment, scheduled_at, started_at,
         finished_at, status
       ) VALUES (?, ?, 'staging', ?, ?, ?, 'completed')`,
    ).bind(`dispatcher-${index}`, SHA, scheduledAt, scheduledAt, scheduledAt);
  });
  for (let index = 0; index < statements.length; index += 80) {
    await testEnv.FORECAST_DB.batch(statements.slice(index, index + 80));
  }
}

async function insertSmokeAndRouterTest() {
  const created = new Date(START + 60_000).toISOString();
  await testEnv.FORECAST_DB.prepare(
    `INSERT INTO workflow_dispatches (
       dispatch_id, slot_key, environment, dispatch_mode, work_fingerprint,
       pending_count, candidate_count, attempt, state, dispatcher_deployment_sha,
       created_at, requested_at, accepted_at, started_at, finished_at,
       github_http_status, github_run_id, github_run_attempt, github_run_url,
       discord_message_id, discord_sent_at
       ) VALUES (?, 'smoke:v7', 'staging', 'smoke', ?, 0, 0, 1, 'succeeded', ?,
       ?, ?, ?, ?, ?, 200, 9001, 1, ?, '123456789012345678', ?)`,
  )
    .bind(
      `fd-${"b".repeat(32)}`,
      "c".repeat(64),
      SHA,
      created,
      created,
      created,
      created,
      created,
      "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/9001",
      created,
    )
    .run();
  await testEnv.FORECAST_DB.prepare(
    `INSERT INTO discord_interaction_audit (
       interaction_id, environment, action, custom_id_hash, received_at,
       initial_response_at, completed_at, initial_response_ms, result
     ) VALUES ('9002', 'staging', 'router_test', ?, ?, ?, ?, 75, 'completed')`,
  )
    .bind("d".repeat(64), created, created, created)
    .run();
}

function readFinalCanaryReport() {
  return readCanaryReport(
    testEnv.FORECAST_DB,
    END,
    SHA,
    "staging",
    undefined,
    runtimeQuotaEvidence(START, END),
  );
}

function runtimeQuotaEvidence(runtimeStartedAt: number, runtimeEndedAt: number) {
  const evidence = quotaEvidence(runtimeEndedAt);
  evidence.workerRuntime.startedAt = new Date(runtimeStartedAt).toISOString();
  evidence.workerRuntime.endedAt = new Date(runtimeEndedAt).toISOString();
  return {
    action: evidence.action,
    observedAt: evidence.observedAt,
    periodStart: evidence.plan.periodStart,
    periodEnd: evidence.plan.periodEnd,
    evidenceHash: "f".repeat(64),
    evidence,
  };
}

function quotaEvidence(nowMs: number): D1QuotaEvidence {
  const observedAt = new Date(nowMs).toISOString();
  const databases: D1QuotaEvidence["databases"] = [
    {
      databaseId: D1_DATABASE_IDS.statsProduction,
      databaseName: "collection-kit-stats",
      rowsReadObserved: 10_000,
      rowsWrittenObserved: 100,
      storageBytesObserved: 1_000_000,
    },
    {
      databaseId: D1_DATABASE_IDS.statsStaging,
      databaseName: "collection-kit-stats-staging",
      rowsReadObserved: 100,
      rowsWrittenObserved: 1,
      storageBytesObserved: 100_000,
    },
    {
      databaseId: D1_DATABASE_IDS.forecastProduction,
      databaseName: "collection-kit-forecast-collector",
      rowsReadObserved: 1_000,
      rowsWrittenObserved: 10,
      storageBytesObserved: 500_000,
    },
    {
      databaseId: D1_DATABASE_IDS.forecastStaging,
      databaseName: "collection-kit-forecast-collector-staging",
      rowsReadObserved: 2_000,
      rowsWrittenObserved: 20,
      storageBytesObserved: 500_000,
    },
    {
      databaseId: D1_DATABASE_IDS.usageGuard,
      databaseName: "collection-kit-usage-guard",
      rowsReadObserved: 500,
      rowsWrittenObserved: 50,
      storageBytesObserved: 100_000,
    },
  ];
  const workers: D1QuotaEvidence["workers"] = [
    worker("collection-kit-forecast-collector-staging", 8),
    worker("collection-kit-forecast-dispatcher-staging", 4),
    worker("collection-kit-forecast-interactions", 2),
    worker("collection-kit-usage-guard", 3),
  ];
  const usage = {
    workerRequests: workers.reduce((sum, value) => sum + value.requestsObserved, 0),
    workerCpuMs: workers.reduce((sum, value) => sum + value.cpuMsObserved, 0),
    d1RowsRead: databases.reduce((sum, value) => sum + value.rowsReadObserved, 0),
    d1RowsWritten: databases.reduce((sum, value) => sum + value.rowsWrittenObserved, 0),
    d1StorageBytes: databases.reduce((sum, value) => sum + value.storageBytesObserved, 0),
  };
  const projectedUsage = {
    workerRequests: 100_000,
    workerCpuMs: 500_000,
    d1RowsRead: 1_000_000,
    d1RowsWritten: 10_000,
    d1StorageBytes: 5_000_000,
  };
  const metrics = buildMetricEvidence(usage, projectedUsage);
  const currentPercent = Math.max(...metrics.map((metric) => metric.currentPercent));
  const projectedPercent = Math.max(...metrics.map((metric) => metric.projectedPercent));
  const governingMetric = [...metrics].sort(
    (left, right) =>
      Math.max(right.currentPercent, right.projectedPercent) -
        Math.max(left.currentPercent, left.projectedPercent) ||
      left.metric.localeCompare(right.metric),
  )[0]?.metric;
  if (!governingMetric) throw new Error("missing_governing_metric_fixture");
  return {
    version: 2,
    source: "cloudflare-paid-account-analytics-v2",
    observedAt,
    plan: {
      id: "workers-paid",
      verified: true,
      state: "Paid",
      frequency: "monthly",
      periodStart: "2026-08-15T00:00:00.000Z",
      periodEnd: "2026-09-15T00:00:00.000Z",
    },
    limits: CLOUDFLARE_PAID_INCLUDED_LIMITS,
    thresholds: CLOUDFLARE_PAID_THRESHOLDS,
    usage,
    projectedUsage,
    metrics,
    utilization: {
      currentPercent,
      projectedPercent,
      governingMetric,
    },
    action: "normal",
    databases,
    workers,
    workerRuntime: {
      startedAt: new Date(
        Math.max(
          Date.parse("2026-08-15T00:00:00.000Z"),
          nowMs - CLOUDFLARE_PAID_THRESHOLDS.canaryHours * 60 * 60 * 1_000,
        ),
      ).toISOString(),
      endedAt: observedAt,
      workers,
    },
    passed: true,
  };
}

function worker(scriptName: string, cpuTimeP99Ms: number): D1QuotaEvidence["workers"][number] {
  return {
    scriptName,
    requestsObserved: 1_000,
    cpuMsObserved: 10_000,
    errorsObserved: 0,
    exceededCpuObserved: 0,
    cpuTimeAverageMs: 10,
    cpuTimeP95Ms: Math.min(cpuTimeP99Ms, cpuTimeP99Ms * 0.8),
    cpuTimeP99Ms,
  };
}
