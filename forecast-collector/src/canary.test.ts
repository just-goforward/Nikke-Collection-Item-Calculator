import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  D1_CANARY_THRESHOLDS,
  D1_DATABASE_IDS,
  D1_FREE_LIMITS,
  type D1QuotaEvidence,
} from "../../shared/d1QuotaEvidence";
import schemaSql from "../schema.sql?raw";
import { readCanaryReport, startCanaryDeployment } from "./canary";
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

describe("canary report v6 storage and start contract", () => {
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

  it("passes an eight-hour 160/160 expected-slot certificate", async () => {
    await insertInvocationSlots("collector", slots(0));
    await insertInvocationSlots("dispatcher", slots(1));

    const report = await readCanaryReport(testEnv.FORECAST_DB, END, SHA, "staging");

    expect(report.version).toBe(6);
    expect(report.canaryId).toBe(CANARY_ID);
    expect(report.quota).toMatchObject({ valid: true, errorCode: null });
    expect(report.window).toMatchObject({ eligible: true, earlyFailure: false });
    expect(report.collector).toMatchObject({
      expectedSlots: 160,
      observedSlots: 160,
      missingSlots: 0,
      deliveryRate: 1,
      completionRate: 1,
    });
    expect(report.dispatcher).toMatchObject({
      expectedSlots: 160,
      observedSlots: 160,
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

  it("rejects stale evidence and canary starts outside the 11 KST window", async () => {
    await expect(
      startCanaryDeployment(testEnv.FORECAST_DB, {
        environment: "production",
        canaryId: `fc-${"c".repeat(32)}`,
        deploymentSha: SHA,
        collectorCron: "*/3 * * * *",
        dispatcherCron: "1-59/3 * * * *",
        quotaEvidence: quotaEvidence(START - 20 * 60_000),
        nowMs: START,
      }),
    ).rejects.toThrow("d1_quota_evidence_stale");

    const outsideWindow = Date.parse("2026-09-02T01:00:30.000Z");
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
    ).rejects.toThrow("canary_start_outside_kst_window");
  });
});

describe("canary report v6 slot evidence", () => {
  it("allows one missing slot but rejects two", async () => {
    const collector = slots(0);
    const dispatcher = slots(1);
    await insertInvocationSlots("collector", collector.slice(1));
    await insertInvocationSlots("dispatcher", dispatcher.slice(0, -1));

    const oneMissing = await readCanaryReport(testEnv.FORECAST_DB, END, SHA, "staging");
    expect(oneMissing.collector).toMatchObject({
      expectedSlots: 160,
      observedSlots: 159,
      missingSlots: 1,
    });
    expect(oneMissing.dispatcher).toMatchObject({
      expectedSlots: 160,
      observedSlots: 159,
      missingSlots: 1,
    });
    expect(oneMissing.passed).toBe(true);

    await testEnv.FORECAST_DB.prepare("DELETE FROM collector_invocations WHERE scheduled_at = ?")
      .bind(collector[1])
      .run();
    const twoMissing = await readCanaryReport(testEnv.FORECAST_DB, END, SHA, "staging");
    expect(twoMissing.collector).toMatchObject({ observedSlots: 158, missingSlots: 2 });
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

    const report = await readCanaryReport(testEnv.FORECAST_DB, END, SHA, "staging");

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

    const report = await readCanaryReport(testEnv.FORECAST_DB, END, SHA, "staging");

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
       ) VALUES (?, 'smoke:v6', 'staging', 'smoke', ?, 0, 0, 1, 'succeeded', ?,
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

function quotaEvidence(nowMs: number): D1QuotaEvidence {
  const observedAt = new Date(nowMs).toISOString();
  const startedAt = new Date(nowMs - 30 * 60_000).toISOString();
  const databases: D1QuotaEvidence["databases"] = [
    {
      databaseId: D1_DATABASE_IDS.statsProduction,
      databaseName: "collection-kit-stats",
      role: "stats-production",
      rowsReadObserved: 10_000,
      rowsWrittenObserved: 100,
      rowsReadP95: 100_000,
      rowsWrittenP95: 1_000,
      rowsReadProjected: 100_000,
      rowsWrittenProjected: 1_000,
    },
    {
      databaseId: D1_DATABASE_IDS.statsStaging,
      databaseName: "collection-kit-stats-staging",
      role: "stats-staging",
      rowsReadObserved: 100,
      rowsWrittenObserved: 1,
      rowsReadP95: 100,
      rowsWrittenP95: 1,
      rowsReadProjected: 100,
      rowsWrittenProjected: 1,
    },
    {
      databaseId: D1_DATABASE_IDS.forecastProduction,
      databaseName: "collection-kit-forecast-collector",
      role: "forecast-production",
      rowsReadObserved: 1_000,
      rowsWrittenObserved: 10,
      rowsReadP95: 1_000,
      rowsWrittenP95: 10,
      rowsReadProjected: 1_000,
      rowsWrittenProjected: 10,
    },
    {
      databaseId: D1_DATABASE_IDS.forecastStaging,
      databaseName: "collection-kit-forecast-collector-staging",
      role: "forecast-staging",
      rowsReadObserved: 2_000,
      rowsWrittenObserved: 20,
      rowsReadP95: 2_000,
      rowsWrittenP95: 20,
      rowsReadProjected: 200_000,
      rowsWrittenProjected: 5_000,
    },
  ];
  return {
    version: 1,
    source: "cloudflare-graphql-d1-analytics-v1",
    billingDay: observedAt.slice(0, 10),
    observedAt,
    burnIn: { startedAt, endedAt: observedAt, durationMinutes: 30 },
    limits: D1_FREE_LIMITS,
    thresholds: D1_CANARY_THRESHOLDS,
    account: {
      rowsReadObserved: 13_100,
      rowsWrittenObserved: 131,
      rowsReadProjected: 301_100,
      rowsWrittenProjected: 6_011,
    },
    canary: {
      databaseId: D1_DATABASE_IDS.forecastStaging,
      rowsReadBurnIn: 10_000,
      rowsWrittenBurnIn: 100,
      rowsReadProjected: 200_000,
      rowsWrittenProjected: 5_000,
    },
    statsProduction: {
      databaseId: D1_DATABASE_IDS.statsProduction,
      rowsReadP95: 100_000,
      rowsWrittenP95: 1_000,
      rowsReadReserve: 1_000_000,
      rowsWrittenReserve: 30_000,
    },
    databases,
    passed: true,
  };
}
