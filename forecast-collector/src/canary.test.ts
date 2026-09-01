import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
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
const START = Date.parse("2026-09-01T00:00:30.000Z");
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
    deploymentSha: SHA,
    collectorCron: "*/3 * * * *",
    dispatcherCron: "1-59/3 * * * *",
    nowMs: START,
  });
  await insertSmokeAndRouterTest();
});

describe("canary report v5", () => {
  it("passes an eight-hour 160/160 expected-slot certificate", async () => {
    await insertInvocationSlots("collector", slots(0));
    await insertInvocationSlots("dispatcher", slots(1));

    const report = await readCanaryReport(testEnv.FORECAST_DB, END, SHA, "staging");

    expect(report.version).toBe(5);
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
     ) VALUES (?, 'smoke:v5', 'staging', 'smoke', ?, 0, 0, 1, 'succeeded', ?,
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
