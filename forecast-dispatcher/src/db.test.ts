import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import schemaSql from "../../forecast-collector/schema.sql?raw";
import {
  listDueAlerts,
  markAlertSendFailed,
  markAlertSent,
  markDispatchAccepted,
  markDispatchRequested,
  raiseOpsAlert,
  readActionableWork,
  reserveNextDispatch,
  resolveOpsAlert,
} from "./db";
import type { DispatcherEnv } from "./types";

const testEnv = env as unknown as DispatcherEnv;

beforeEach(async () => {
  await reset();
  for (const statement of schemaSql
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    await testEnv.FORECAST_DB.prepare(statement).run();
  }
});

describe("forecast dispatcher D1 reservations", () => {
  it("grants one owner per three-minute slot and suppresses a recently accepted fingerprint", async () => {
    const now = Date.parse("2026-08-31T00:00:00.000Z");
    await insertPending("100", now);
    const work = await readActionableWork(testEnv.FORECAST_DB, "staging");

    const first = await reserveNextDispatch(testEnv.FORECAST_DB, {
      environment: "staging",
      invocationId: "invocation-a",
      deploymentSha: "test-sha",
      work,
      nowMs: now,
    });
    const duplicate = await reserveNextDispatch(testEnv.FORECAST_DB, {
      environment: "staging",
      invocationId: "invocation-b",
      deploymentSha: "test-sha",
      work,
      nowMs: now,
    });

    expect(first).toMatchObject({ mode: "work", pendingCount: 1, attempt: 1 });
    expect(duplicate).toBeNull();
    if (!first) throw new Error("Expected a reservation.");
    await markDispatchRequested(testEnv.FORECAST_DB, first.dispatchId, "invocation-a", now);
    await markDispatchAccepted(testEnv.FORECAST_DB, first.dispatchId, "invocation-a", now, {
      status: 204,
      runId: null,
      runUrl: null,
    });

    await expect(
      reserveNextDispatch(testEnv.FORECAST_DB, {
        environment: "staging",
        invocationId: "invocation-c",
        deploymentSha: "test-sha",
        work,
        nowMs: now + 19 * 60 * 1_000,
      }),
    ).resolves.toBeNull();
    await expect(
      reserveNextDispatch(testEnv.FORECAST_DB, {
        environment: "staging",
        invocationId: "invocation-d",
        deploymentSha: "test-sha",
        work,
        nowMs: now + 21 * 60 * 1_000,
      }),
    ).resolves.toMatchObject({ mode: "work", attempt: 2 });
  });

  it("reclaims a smoke reservation only after its five-minute lease expires", async () => {
    const now = Date.parse("2026-08-31T00:00:00.000Z");
    const fingerprint = "a".repeat(64);
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO workflow_dispatches (
         dispatch_id, slot_key, environment, dispatch_mode, work_fingerprint,
         pending_count, candidate_count, attempt, state, created_at, next_attempt_at
       ) VALUES (?, 'smoke:test', 'staging', 'smoke', ?, 0, 0, 1, 'pending', ?, ?)`,
    )
      .bind(
        `fd-${"b".repeat(32)}`,
        fingerprint,
        new Date(now).toISOString(),
        new Date(now).toISOString(),
      )
      .run();
    const work = await readActionableWork(testEnv.FORECAST_DB, "staging");

    const first = await reserveNextDispatch(testEnv.FORECAST_DB, {
      environment: "staging",
      invocationId: "smoke-a",
      deploymentSha: "test-sha",
      work,
      nowMs: now,
    });
    const duringLease = await reserveNextDispatch(testEnv.FORECAST_DB, {
      environment: "staging",
      invocationId: "smoke-b",
      deploymentSha: "test-sha",
      work,
      nowMs: now + 4 * 60 * 1_000,
    });
    const afterLease = await reserveNextDispatch(testEnv.FORECAST_DB, {
      environment: "staging",
      invocationId: "smoke-c",
      deploymentSha: "test-sha",
      work,
      nowMs: now + 6 * 60 * 1_000,
    });

    expect(first).toMatchObject({ mode: "smoke", attempt: 1 });
    expect(duringLease).toBeNull();
    expect(afterLease).toMatchObject({ mode: "smoke", attempt: 2 });
  });
});

describe("forecast dispatcher alert grouping", () => {
  it("waits for the threshold, suppresses duplicate sends, and sends one recovery", async () => {
    const now = Date.parse("2026-08-31T00:00:00.000Z");
    const input = {
      alertKey: "github-dispatch:staging",
      environment: "staging" as const,
      severity: "critical" as const,
      component: "github-app",
      errorCode: "github_500",
      notifyAfterCount: 3,
    };
    await raiseOpsAlert(testEnv.FORECAST_DB, { ...input, nowMs: now });
    await raiseOpsAlert(testEnv.FORECAST_DB, { ...input, nowMs: now + 1_000 });
    await expect(listDueAlerts(testEnv.FORECAST_DB, "staging", now + 1_000)).resolves.toEqual([]);
    await raiseOpsAlert(testEnv.FORECAST_DB, { ...input, nowMs: now + 2_000 });
    const due = await listDueAlerts(testEnv.FORECAST_DB, "staging", now + 2_000);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ occurrenceCount: 3, state: "open" });
    if (!due[0]) throw new Error("Expected a due alert.");
    await markAlertSent(testEnv.FORECAST_DB, due[0], "123456789012345678", now + 2_000);

    await raiseOpsAlert(testEnv.FORECAST_DB, { ...input, nowMs: now + 3_000 });
    await expect(listDueAlerts(testEnv.FORECAST_DB, "staging", now + 3_000)).resolves.toEqual([]);
    await expect(
      listDueAlerts(testEnv.FORECAST_DB, "staging", now + 31 * 60 * 1_000),
    ).resolves.toHaveLength(1);

    await resolveOpsAlert(testEnv.FORECAST_DB, input.alertKey, now + 32 * 60 * 1_000);
    const recovery = await listDueAlerts(testEnv.FORECAST_DB, "staging", now + 32 * 60 * 1_000);
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.state).toBe("resolved");
    if (!recovery[0]) throw new Error("Expected a recovery alert.");
    await markAlertSent(
      testEnv.FORECAST_DB,
      recovery[0],
      "123456789012345679",
      now + 32 * 60 * 1_000,
    );
    await expect(
      listDueAlerts(testEnv.FORECAST_DB, "staging", now + 33 * 60 * 1_000),
    ).resolves.toEqual([]);
  });

  it.each([65_000, 1_337_000])(
    "persists a Discord retry delay of %i ms without blocking the Worker",
    async (retryAfterMs) => {
      const now = Date.parse("2026-09-01T00:00:00.000Z");
      await raiseOpsAlert(testEnv.FORECAST_DB, {
        alertKey: `discord-retry:${retryAfterMs}`,
        environment: "staging",
        severity: "critical",
        component: "discord",
        errorCode: "discord_create_message_429",
        context: {},
        nowMs: now,
      });

      await markAlertSendFailed(
        testEnv.FORECAST_DB,
        `discord-retry:${retryAfterMs}`,
        "discord_create_message_429",
        now,
        retryAfterMs,
      );

      const row = await testEnv.FORECAST_DB.prepare(
        "SELECT next_send_at, last_send_error FROM forecast_ops_alerts WHERE alert_key = ?",
      )
        .bind(`discord-retry:${retryAfterMs}`)
        .first<{ next_send_at: string; last_send_error: string }>();
      expect(row).toEqual({
        next_send_at: new Date(now + retryAfterMs).toISOString(),
        last_send_error: "discord_create_message_429",
      });
    },
  );
});

async function insertPending(itemId: string, nowMs: number) {
  const now = new Date(nowMs).toISOString();
  await testEnv.FORECAST_DB.prepare(
    `INSERT INTO source_queue (
       source, item_id, url, title, published_at, official, status,
       attempts, first_seen_at, updated_at
     ) VALUES ('naver-board-56', ?, ?, '솔로 레이드 안내', ?, 1, 'pending', 0, ?, ?)`,
  )
    .bind(itemId, `https://game.naver.com/lounge/nikke/board/detail/${itemId}`, now, now, now)
    .run();
}
