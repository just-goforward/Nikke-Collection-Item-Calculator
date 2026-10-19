import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schemaSql from "../../forecast-collector/schema.sql?raw";
import { executeTestSql } from "../../shared/testD1Sql";
import {
  listDueAlerts,
  markAlertSendFailed,
  markAlertSent,
  raiseOpsAlert,
  readActionableWork,
  resolveOpsAlert,
} from "./db";
import type { DispatcherEnv } from "./types";

const testEnv = env as unknown as DispatcherEnv;

const deniedFetch = vi.fn(async () => {
  throw new Error("Unexpected outbound fetch in dispatcher D1 tests.");
});

beforeEach(async () => {
  deniedFetch.mockClear();
  vi.stubGlobal("fetch", deniedFetch);
  await reset();
  await executeTestSql(testEnv.FORECAST_DB, schemaSql, applyD1Migrations);
});

afterEach(() => {
  try {
    expect(deniedFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("forecast dispatcher D1 reservations", () => {
  it("preserves the canonical SHA-256 identity for empty work without runtime hashing", async () => {
    const work = await readActionableWork(testEnv.FORECAST_DB, "staging");

    expect(work).toMatchObject({
      pendingCount: 0,
      candidateCount: 0,
      fingerprint: "faee245f61e12ff37e07bdd6778379da818d2c3dbf1b76e545babc3e5e012c6b",
    });
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
        await dueAlert(now),
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

describe("forecast dispatcher recurrence-linked alert completion", () => {
  const now = Date.parse("2026-09-01T23:59:59.999Z");
  const input = {
    alertKey: "recurrence:staging",
    environment: "staging" as const,
    severity: "critical" as const,
    component: "dispatcher",
    errorCode: "test_failure",
  };
  const firstMessage = "123456789012345678";
  const newerMessage = "123456789012345679";

  it("records only the sent snapshot count and preserves suppression during open observations", async () => {
    await raiseOpsAlert(testEnv.FORECAST_DB, { ...input, nowMs: now });
    const first = await dueAlert(now);
    await raiseOpsAlert(testEnv.FORECAST_DB, { ...input, nowMs: now + 1 });
    await markAlertSent(testEnv.FORECAST_DB, first, firstMessage, now + 2);
    await raiseOpsAlert(testEnv.FORECAST_DB, { ...input, nowMs: now + 3 });

    expect(await deliveryState(input.alertKey)).toMatchObject({
      first_seen_at: first.firstSeenAt,
      occurrence_count: 3,
      last_sent_occurrence_count: 1,
      last_sent_at: new Date(now + 2).toISOString(),
      discord_message_id: firstMessage,
      next_send_at: new Date(now + 2 + 30 * 60 * 1_000).toISOString(),
    });
    expect(await listDueAlerts(testEnv.FORECAST_DB, "staging", now + 3)).toEqual([]);
    expect(await dueAlert(now + 2 + 30 * 60 * 1_000)).toMatchObject({
      occurrenceCount: 3,
      lastSentOccurrenceCount: 1,
    });
  });

  it("still requires the threshold in a reopened recurrence", async () => {
    const thresholdInput = { ...input, notifyAfterCount: 3 };
    for (const offset of [0, 1, 2]) {
      await raiseOpsAlert(testEnv.FORECAST_DB, { ...thresholdInput, nowMs: now + offset });
    }
    await markAlertSent(testEnv.FORECAST_DB, await dueAlert(now + 2), firstMessage, now + 2);
    await resolveOpsAlert(testEnv.FORECAST_DB, input.alertKey, now + 3);
    for (const offset of [4, 5]) {
      await raiseOpsAlert(testEnv.FORECAST_DB, { ...thresholdInput, nowMs: now + offset });
      expect(await listDueAlerts(testEnv.FORECAST_DB, "staging", now + offset)).toEqual([]);
    }
    await raiseOpsAlert(testEnv.FORECAST_DB, { ...thresholdInput, nowMs: now + 6 });
    expect(await dueAlert(now + 6)).toMatchObject({
      occurrenceCount: 3,
      lastSentOccurrenceCount: 0,
      firstSeenAt: new Date(now + 4).toISOString(),
    });
  });

  it("does not let old or duplicate completion overwrite a newer open success", async () => {
    await raiseOpsAlert(testEnv.FORECAST_DB, { ...input, nowMs: now });
    const first = await dueAlert(now);
    await raiseOpsAlert(testEnv.FORECAST_DB, { ...input, nowMs: now + 1 });
    const second = await dueAlert(now + 1);
    await markAlertSent(testEnv.FORECAST_DB, second, newerMessage, now + 2);
    const completed = await deliveryState(input.alertKey);

    await markAlertSent(testEnv.FORECAST_DB, first, firstMessage, now + 3);
    await markAlertSendFailed(testEnv.FORECAST_DB, first, "old_failure", now + 4);
    await markAlertSent(testEnv.FORECAST_DB, second, firstMessage, now + 5);
    await markAlertSendFailed(testEnv.FORECAST_DB, second, "duplicate_failure", now + 6);
    expect(await deliveryState(input.alertKey)).toEqual(completed);
  });

  it("ignores failure captured before a newer success even when its count is higher", async () => {
    await raiseOpsAlert(testEnv.FORECAST_DB, { ...input, nowMs: now });
    const first = await dueAlert(now);
    await raiseOpsAlert(testEnv.FORECAST_DB, { ...input, nowMs: now + 1 });
    const second = await dueAlert(now + 1);
    await markAlertSent(testEnv.FORECAST_DB, first, firstMessage, now + 2);
    const completed = await deliveryState(input.alertKey);
    await markAlertSendFailed(testEnv.FORECAST_DB, second, "late_failure", now + 3);
    expect(await deliveryState(input.alertKey)).toEqual(completed);
    await markAlertSent(testEnv.FORECAST_DB, second, newerMessage, now + 4);
    expect(await deliveryState(input.alertKey)).toMatchObject({
      last_sent_occurrence_count: 2,
      discord_message_id: newerMessage,
    });
  });

  it("discards open completion after resolution and never manufactures recovery eligibility", async () => {
    await raiseOpsAlert(testEnv.FORECAST_DB, { ...input, nowMs: now });
    const open = await dueAlert(now);
    await resolveOpsAlert(testEnv.FORECAST_DB, input.alertKey, now + 1);
    const resolved = await deliveryState(input.alertKey);
    await markAlertSent(testEnv.FORECAST_DB, open, firstMessage, now + 2);
    await markAlertSendFailed(testEnv.FORECAST_DB, open, "late_failure", now + 3);
    expect(await deliveryState(input.alertKey)).toEqual(resolved);
    expect(await listDueAlerts(testEnv.FORECAST_DB, "staging", now + 3)).toEqual([]);
  });

  it.each([1, 65_000, 1_337_000, 4_000_000])(
    "honors recovery retry delay %i with the existing clamps",
    async (retryAfterMs) => {
      await raiseOpsAlert(testEnv.FORECAST_DB, { ...input, nowMs: now });
      await markAlertSent(testEnv.FORECAST_DB, await dueAlert(now), firstMessage, now);
      await resolveOpsAlert(testEnv.FORECAST_DB, input.alertKey, now + 1);
      const recovery = await dueAlert(now + 1);
      await markAlertSendFailed(
        testEnv.FORECAST_DB,
        recovery,
        "discord_create_message_429",
        now + 2,
        retryAfterMs,
      );
      const retryAt = now + 2 + Math.min(Math.max(retryAfterMs, 250), 60 * 60 * 1_000);
      expect(await deliveryState(input.alertKey)).toMatchObject({
        next_send_at: new Date(retryAt).toISOString(),
        last_send_error: "discord_create_message_429",
      });
      expect(await listDueAlerts(testEnv.FORECAST_DB, "staging", retryAt - 1)).toEqual([]);
      expect(await dueAlert(retryAt)).toMatchObject({ state: "resolved" });
    },
  );
});

async function dueAlert(nowMs: number) {
  const alerts = await listDueAlerts(testEnv.FORECAST_DB, "staging", nowMs);
  const alert = alerts[0];
  if (!alert) throw new Error("Expected a due alert.");
  return alert;
}

async function deliveryState(alertKey: string) {
  return testEnv.FORECAST_DB.prepare(
    `SELECT state, occurrence_count, first_seen_at, last_sent_at, last_sent_occurrence_count,
            next_send_at, discord_message_id, resolved_at, recovery_sent_at, last_send_error
     FROM forecast_ops_alerts WHERE alert_key = ?`,
  )
    .bind(alertKey)
    .first<{
      state: string;
      occurrence_count: number;
      first_seen_at: string;
      last_sent_at: string | null;
      last_sent_occurrence_count: number;
      next_send_at: string | null;
      discord_message_id: string | null;
      resolved_at: string | null;
      recovery_sent_at: string | null;
      last_send_error: string | null;
    }>();
}
