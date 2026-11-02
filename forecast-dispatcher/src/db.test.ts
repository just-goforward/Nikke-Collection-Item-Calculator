import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schemaSql from "../../forecast-collector/schema.sql?raw";
import { executeTestSql } from "../../shared/testD1Sql";
import {
  expireBudgetIncidents,
  listDueAlerts,
  markAlertSendFailed,
  markAlertSent,
  raiseOpsAlert,
  resolveOpsAlert,
  retireLegacyBudgetAlerts,
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

describe("forecast dispatcher budget incidents", () => {
  const now = Date.parse("2026-10-18T10:00:00.000Z"); // 19:00 KST, mid game day
  const incidentKey = "forecast-v2:staging:budget:metadata:2026-10-18";

  async function raiseIncident(atMs: number, key = incidentKey) {
    await raiseOpsAlert(testEnv.FORECAST_DB, {
      alertKey: key,
      environment: "staging",
      severity: "warning",
      component: "collector",
      errorCode: "budget_exhausted",
      context: { gameDay: "2026-10-18", kind: "metadata", used: 240, limit: 240 },
      nowMs: atMs,
    });
  }

  it("delivers once and never renews while later holds raise the occurrence count", async () => {
    await raiseIncident(now);
    const first = await dueAlert(now);
    expect(first).toMatchObject({ alertKey: incidentKey, occurrenceCount: 1 });
    await markAlertSent(testEnv.FORECAST_DB, first, "123456789012345678", now);
    await raiseIncident(now + 60_000);
    await raiseIncident(now + 120_000);
    await expect(listDueAlerts(testEnv.FORECAST_DB, "staging", now + 120_000)).resolves.toEqual([]);
    await expect(
      listDueAlerts(testEnv.FORECAST_DB, "staging", now + 31 * 60 * 1_000),
    ).resolves.toEqual([]);
    expect(await deliveryState(incidentKey)).toMatchObject({
      occurrence_count: 3,
      last_sent_occurrence_count: 1,
    });
  });

  it("never delivers an incident whose game day already ended", async () => {
    await raiseIncident(now);
    const nextDay = Date.parse("2026-10-18T20:00:00.000Z"); // 05:00 KST
    await expect(listDueAlerts(testEnv.FORECAST_DB, "staging", nextDay)).resolves.toEqual([]);
  });

  it("closes an ended incident silently, without a recovery delivery", async () => {
    await raiseIncident(now);
    await markAlertSent(testEnv.FORECAST_DB, await dueAlert(now), "123456789012345678", now);
    const nextDay = Date.parse("2026-10-18T20:00:00.000Z");
    await expireBudgetIncidents(testEnv.FORECAST_DB, "staging", nextDay);
    expect(await deliveryState(incidentKey)).toMatchObject({
      state: "resolved",
      resolved_at: new Date(nextDay).toISOString(),
      recovery_sent_at: new Date(nextDay).toISOString(),
    });
    await expect(listDueAlerts(testEnv.FORECAST_DB, "staging", nextDay + 60_000)).resolves.toEqual(
      [],
    );
  });

  it("suppresses the retired legacy keys but keeps unexplained budget alerts deliverable", async () => {
    const legacyKey = "forecast-v2:staging:A:budget_exhausted";
    const unexplainedKey = "forecast-v2:staging:A:budget_unexplained";
    await raiseIncident(now, legacyKey);
    await raiseIncident(now, unexplainedKey);
    const due = await listDueAlerts(testEnv.FORECAST_DB, "staging", now);
    expect(due.map((alert) => alert.alertKey)).toEqual([unexplainedKey]);
    await retireLegacyBudgetAlerts(testEnv.FORECAST_DB, "staging", now);
    expect(await deliveryState(legacyKey)).toMatchObject({
      state: "resolved",
      recovery_sent_at: new Date(now).toISOString(),
    });
    await expect(listDueAlerts(testEnv.FORECAST_DB, "staging", now)).resolves.toHaveLength(1);
  });

  it("stops sweeping legacy keys after the sunset", async () => {
    const { LEGACY_BUDGET_SUNSET_MS } = await import("../../shared/forecastOpsAlerts.ts");
    expect(await retireLegacyBudgetAlerts(testEnv.FORECAST_DB, "staging", now)).toBe(true);
    expect(
      await retireLegacyBudgetAlerts(testEnv.FORECAST_DB, "staging", LEGACY_BUDGET_SUNSET_MS + 1),
    ).toBe(false);
  });

  it("reports invalid legacy context instead of hiding it behind the fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO forecast_ops_alerts (alert_key,environment,severity,component,error_code,state,
        context_json,notify_after_count,occurrence_count,first_seen_at,last_seen_at,next_send_at)
       VALUES ('fixture:broken-context','staging','warning','collector','fixture','open','{oops',1,1,?,?,?)`,
    )
      .bind(new Date(now).toISOString(), new Date(now).toISOString(), new Date(now).toISOString())
      .run();
    const due = await dueAlert(now);
    expect(due.context).toEqual({ invalidContext: true });
    expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toMatchObject({
      event: "forecast_ops_context_invalid",
      alertKey: "fixture:broken-context",
      code: "invalid_json",
    });
  });
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
