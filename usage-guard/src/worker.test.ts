import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { D1QuotaEvidence } from "../../shared/d1QuotaEvidence";
import { assertUsageAllowed, type UsageGuardError } from "../../shared/usageGuard";
import schemaSql from "../schema.sql?raw";
import type { StoredGuardState, UsageGuardEnv } from "./types";
import worker, {
  actionAlertRequired,
  findQuotaBaseline,
  runUsageGuard,
  transitionAction,
  usageGuardRunId,
} from "./worker";

const testEnv = env as unknown as UsageGuardEnv;
const NOW = Date.parse("2026-09-01T02:00:00.000Z");

beforeEach(async () => {
  await reset();
  for (const statement of schemaSql
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    await testEnv.GUARD_DB.prepare(statement).run();
  }
});

describe("usage guard state transitions", () => {
  it("latches stricter actions inside a billing period", () => {
    const previous = state("warning", "2026-08-15T00:00:00.000Z");
    expect(transitionAction(previous, evidence("normal", previous.period_start))).toEqual({
      action: "warning",
      normalStreak: 1,
      releasePending: false,
    });
    expect(
      transitionAction(previous, evidence("disable_statistics_writes", previous.period_start)),
    ).toEqual({
      action: "disable_statistics_writes",
      normalStreak: 0,
      releasePending: false,
    });
  });

  it("requires two normal observations in a new billing period before releasing a latch", () => {
    const first = transitionAction(
      state("hard_stop", "2026-08-15T00:00:00.000Z"),
      evidence("normal", "2026-09-15T00:00:00.000Z"),
    );
    expect(first).toEqual({ action: "hard_stop", normalStreak: 1, releasePending: true });

    const secondState = state("hard_stop", "2026-09-15T00:00:00.000Z", 1, true);
    expect(transitionAction(secondState, evidence("normal", secondState.period_start))).toEqual({
      action: "normal",
      normalStreak: 2,
      releasePending: false,
    });
  });

  it("does not relax a prior-period latch on a non-normal first observation", () => {
    expect(
      transitionAction(
        state("hard_stop", "2026-08-15T00:00:00.000Z"),
        evidence("warning", "2026-09-15T00:00:00.000Z"),
      ),
    ).toEqual({ action: "hard_stop", normalStreak: 0, releasePending: true });

    expect(
      transitionAction(
        state("warning", "2026-08-15T00:00:00.000Z"),
        evidence("disable_staging", "2026-09-15T00:00:00.000Z"),
      ),
    ).toEqual({ action: "disable_staging", normalStreak: 0, releasePending: true });
  });

  it("requires two later normal observations after a non-normal new-period observation", () => {
    const firstNormal = transitionAction(
      state("hard_stop", "2026-09-15T00:00:00.000Z", 0, true),
      evidence("normal", "2026-09-15T00:00:00.000Z"),
    );
    expect(firstNormal).toEqual({ action: "hard_stop", normalStreak: 1, releasePending: true });

    expect(
      transitionAction(
        state("hard_stop", "2026-09-15T00:00:00.000Z", 1, true),
        evidence("normal", "2026-09-15T00:00:00.000Z"),
      ),
    ).toEqual({ action: "normal", normalStreak: 2, releasePending: false });
  });

  it("keeps a new-period release pending across repeated non-normal observations", () => {
    const repeatedPressure = transitionAction(
      state("hard_stop", "2026-09-15T00:00:00.000Z", 0, true),
      evidence("warning", "2026-09-15T00:00:00.000Z"),
    );
    expect(repeatedPressure).toEqual({
      action: "hard_stop",
      normalStreak: 0,
      releasePending: true,
    });

    const firstNormal = transitionAction(
      state("hard_stop", "2026-09-15T00:00:00.000Z", 0, repeatedPressure.releasePending),
      evidence("normal", "2026-09-15T00:00:00.000Z"),
    );
    expect(firstNormal).toEqual({ action: "hard_stop", normalStreak: 1, releasePending: true });
  });

  it("does not send a red state-change alert for the first normal observation", () => {
    expect(actionAlertRequired(null, "normal")).toBe(false);
    expect(actionAlertRequired(null, "warning")).toBe(true);
    expect(actionAlertRequired({ last_alert_action: "warning" }, "warning")).toBe(false);
    expect(actionAlertRequired({ last_alert_action: "warning" }, "normal")).toBe(true);
  });
});

describe("usage guard operation enforcement", () => {
  it("keeps reads available at 45% while denying statistics writes", async () => {
    await insertState("disable_statistics_writes", new Date(NOW).toISOString());
    await expect(
      assertUsageAllowed(testEnv.GUARD_DB, "statistics_read", NOW),
    ).resolves.toMatchObject({
      action: "disable_statistics_writes",
    });
    await expect(assertUsageAllowed(testEnv.GUARD_DB, "statistics_write", NOW)).rejects.toEqual(
      expect.objectContaining<Partial<UsageGuardError>>({
        code: "telemetry_budget_disabled",
        retryable: false,
      }),
    );
  });

  it("escalates stale evidence without allowing retries to consume more D1", async () => {
    await insertState("normal", new Date(NOW - 121 * 60_000).toISOString());
    await expect(
      assertUsageAllowed(testEnv.GUARD_DB, "statistics_read", NOW),
    ).rejects.toMatchObject({
      action: "hard_stop",
      retryable: false,
    });
  });

  it("stops production Forecast automation after 45 stale minutes while preserving statistics", async () => {
    await insertState("normal", new Date(NOW - 46 * 60_000).toISOString());

    await expect(
      assertUsageAllowed(testEnv.GUARD_DB, "statistics_write", NOW),
    ).resolves.toMatchObject({
      action: "disable_forecast_production",
    });
    await expect(
      assertUsageAllowed(testEnv.GUARD_DB, "production_forecast_automation", NOW),
    ).rejects.toMatchObject({
      action: "disable_forecast_production",
      retryable: false,
    });
  });

  it("hard-stops an expired billing period before the next observation arrives", async () => {
    await insertState("normal", new Date(NOW).toISOString());
    await testEnv.GUARD_DB.prepare(
      "UPDATE usage_guard_state SET period_end = ? WHERE singleton_id = 1",
    )
      .bind(new Date(NOW).toISOString())
      .run();

    await expect(
      assertUsageAllowed(testEnv.GUARD_DB, "statistics_read", NOW),
    ).rejects.toMatchObject({
      action: "hard_stop",
      retryable: false,
    });
  });

  it("hard-stops an observation timestamp that is more than one minute in the future", async () => {
    await insertState("normal", new Date(NOW + 2 * 60_000).toISOString());

    await expect(
      assertUsageAllowed(testEnv.GUARD_DB, "statistics_write", NOW),
    ).rejects.toMatchObject({
      action: "hard_stop",
      retryable: false,
    });
  });

  it("exposes the same stale escalation through health for the independent watchdog", async () => {
    await insertState("normal", new Date(NOW - 121 * 60_000).toISOString());
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      const request = new Request("https://usage-guard.test/health") as unknown as Parameters<
        typeof worker.fetch
      >[0];
      const response = await worker.fetch(request, testEnv);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        effectiveAction: "hard_stop",
        state: { action: "hard_stop" },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("usage guard invocation identity", () => {
  it("does not repeat analytics or notifications for the same scheduled invocation", async () => {
    const scheduledAt = new Date(NOW).toISOString();
    const runId = await usageGuardRunId(testEnv.DEPLOY_SHA, scheduledAt);
    await testEnv.GUARD_DB.prepare(
      `INSERT INTO usage_guard_runs (
         run_id, scheduled_at, started_at, finished_at, status, deployment_sha
       ) VALUES (?, ?, ?, ?, 'completed', ?)`,
    )
      .bind(runId, scheduledAt, scheduledAt, scheduledAt, testEnv.DEPLOY_SHA)
      .run();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected_fetch"));

    try {
      await runUsageGuard(testEnv, NOW);
      expect(fetchSpy).not.toHaveBeenCalled();
      const rows = await testEnv.GUARD_DB.prepare(
        "SELECT COUNT(*) AS count FROM usage_guard_runs WHERE run_id = ?",
      )
        .bind(runId)
        .first<{ count: number }>();
      expect(rows?.count).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses the longest available window up to six hours for recent-rate projection", async () => {
    const periodStart = "2026-08-15T00:00:00.000Z";
    const captures = [NOW - 5 * 60 * 60_000, NOW - 30 * 60_000];
    for (const capturedAt of captures) {
      const timestamp = new Date(capturedAt).toISOString();
      const snapshotJson = JSON.stringify({ capturedAt: timestamp });
      await testEnv.GUARD_DB.prepare(
        `INSERT INTO usage_guard_snapshots (
           snapshot_id, captured_at, period_start, period_end,
           snapshot_json, snapshot_hash, created_at
         ) VALUES (?, ?, ?, '2026-09-15T00:00:00.000Z', ?, ?, ?)`,
      )
        .bind(
          String(capturedAt),
          timestamp,
          periodStart,
          snapshotJson,
          await testHash(snapshotJson),
          timestamp,
        )
        .run();
    }

    await expect(
      findQuotaBaseline(testEnv.GUARD_DB, {
        capturedAt: new Date(NOW).toISOString(),
        plan: {
          id: "workers-paid",
          verified: true,
          state: "Paid",
          frequency: "monthly",
          periodStart,
          periodEnd: "2026-09-15T00:00:00.000Z",
          subscriptionId: "subscription-1",
          ratePlanId: "workers-paid",
        },
      }),
    ).resolves.toMatchObject({ capturedAt: new Date(captures[0] ?? 0).toISOString() });
  });

  it("rejects a corrupted recent-rate baseline snapshot", async () => {
    const timestamp = new Date(NOW - 30 * 60_000).toISOString();
    await testEnv.GUARD_DB.prepare(
      `INSERT INTO usage_guard_snapshots (
         snapshot_id, captured_at, period_start, period_end,
         snapshot_json, snapshot_hash, created_at
       ) VALUES ('corrupt', ?, '2026-08-15T00:00:00.000Z',
                 '2026-09-15T00:00:00.000Z', '{}', ?, ?)`,
    )
      .bind(timestamp, "0".repeat(64), timestamp)
      .run();

    await expect(
      findQuotaBaseline(testEnv.GUARD_DB, {
        capturedAt: new Date(NOW).toISOString(),
        plan: {
          id: "workers-paid",
          verified: true,
          state: "Paid",
          frequency: "monthly",
          periodStart: "2026-08-15T00:00:00.000Z",
          periodEnd: "2026-09-15T00:00:00.000Z",
          subscriptionId: "subscription-1",
          ratePlanId: "workers-paid",
        },
      }),
    ).rejects.toThrow("usage_guard_snapshot_hash_mismatch");
  });
});

function evidence(action: D1QuotaEvidence["action"], periodStart: string) {
  return { action, plan: { periodStart } } as D1QuotaEvidence;
}

function state(
  action: StoredGuardState["action"],
  periodStart: string,
  normalStreak = 0,
  releasePending = false,
): StoredGuardState {
  return {
    action,
    observed_at: new Date(NOW).toISOString(),
    period_start: periodStart,
    period_end: "2026-10-15T00:00:00.000Z",
    evidence_json: "{}",
    evidence_hash: "0".repeat(64),
    current_percent: 0,
    projected_percent: 0,
    governing_metric: "workerRequests",
    normal_streak: normalStreak,
    release_pending: releasePending ? 1 : 0,
    last_alert_action: null,
  };
}

async function insertState(action: string, observedAt: string) {
  await testEnv.GUARD_DB.prepare(
    `INSERT INTO usage_guard_state (
       singleton_id, action, observed_at, period_start, period_end,
       evidence_json, evidence_hash, current_percent, projected_percent,
       governing_metric, normal_streak, release_pending, updated_at
     ) VALUES (1, ?, ?, '2026-08-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z',
               '{}', ?, 0, 0, 'workerRequests', 2, 0, ?)`,
  )
    .bind(action, observedAt, "0".repeat(64), observedAt)
    .run();
}

async function testHash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
