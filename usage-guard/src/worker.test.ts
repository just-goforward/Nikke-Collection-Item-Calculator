import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CloudflarePaidUsageSnapshot,
  evaluateD1PreflightBudget,
} from "../../shared/cloudflarePaidUsage";
import {
  CLOUDFLARE_PAID_INCLUDED_LIMITS,
  CLOUDFLARE_PAID_THRESHOLDS,
  D1_DATABASE_IDS,
  type D1QuotaEvidence,
  QUOTA_ACTIONS,
} from "../../shared/d1QuotaEvidence";
import { assertUsageAllowed, type UsageGuardError } from "../../shared/usageGuard";
import schemaSql from "../schema.sql?raw";
import type { StoredGuardState, UsageGuardEnv } from "./types";
import worker, {
  actionAlertRequired,
  findQuotaBaseline,
  recordSuccessfulEvaluation,
  runUsageGuard,
  transitionAction,
  usageGuardRunId,
} from "./worker";

const testEnv = env as unknown as UsageGuardEnv;
const NOW = Date.parse("2026-09-01T02:00:00.000Z");

beforeEach(async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected_fetch"));
  await reset();
  for (const statement of schemaSql
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    await testEnv.GUARD_DB.prepare(statement).run();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("atomic usage guard transitions", () => {
  it("matches transitionAction for initial, same-period, rollover and pending-release states", async () => {
    const oldPeriod = "2026-08-15T00:00:00.000Z";
    const newPeriod = "2026-09-15T00:00:00.000Z";
    const cases: { previous: StoredGuardState | null; periodStart: string }[] = [
      { previous: null, periodStart: oldPeriod },
    ];
    for (const action of QUOTA_ACTIONS) {
      cases.push(
        { previous: state(action, oldPeriod), periodStart: oldPeriod },
        { previous: state(action, oldPeriod), periodStart: newPeriod },
        { previous: state(action, newPeriod, 0, true), periodStart: newPeriod },
        { previous: state(action, newPeriod, 1, true), periodStart: newPeriod },
      );
    }
    let runIndex = 0;
    for (const { previous, periodStart } of cases) {
      for (const action of QUOTA_ACTIONS) {
        await testEnv.GUARD_DB.prepare("DELETE FROM usage_guard_state").run();
        const observedAt =
          periodStart === oldPeriod ? NOW + 60_000 : Date.parse("2026-09-16T02:00:00.000Z");
        const sample = observation(action, observedAt, periodStart);
        if (previous) {
          await seedStoredState({
            ...previous,
            observed_at: new Date(observedAt - 60_000).toISOString(),
            period_end:
              previous.period_start === oldPeriod
                ? "2026-09-15T00:00:00.000Z"
                : "2026-10-15T00:00:00.000Z",
          });
        }
        const expected = transitionAction(previous, sample.evidence);
        const expectedAlert = actionAlertRequired(previous, expected.action);
        const runId = `parity-${runIndex++}`;
        await reserveTestRun(runId);
        await recordSample(runId, sample);
        const stored = await storedState();
        expect(stored, runId).toMatchObject({
          action: expected.action,
          normal_streak: expected.normalStreak,
          release_pending: expected.releasePending ? 1 : 0,
          observed_at: sample.evidence.observedAt,
          period_start: sample.evidence.plan.periodStart,
          period_end: sample.evidence.plan.periodEnd,
          current_percent: sample.evidence.utilization.currentPercent,
          projected_percent: sample.evidence.utilization.projectedPercent,
        });
        expect(await testHash(stored.evidence_json), runId).toBe(stored.evidence_hash);
        expect(JSON.parse(stored.evidence_json), runId).toEqual(sample.evidence);
        expect(await storedRun(runId), runId).toMatchObject({
          status: "completed",
          effective_action: expected.action,
          alert_status: expectedAlert ? "not_configured" : "unchanged",
        });
      }
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }, 30_000);

  it.each([false, true])(
    "uses the actual current row after a competing hard_stop (existing state: %s)",
    async (existing) => {
      if (existing) {
        await seedStoredState({
          ...state("warning", "2026-08-15T00:00:00.000Z"),
          observed_at: new Date(NOW - 60_000).toISOString(),
          period_end: "2026-09-15T00:00:00.000Z",
        });
      }
      await reserveTestRun("delayed-normal");
      await reserveTestRun("competing-stop");
      await withPausedPublication(
        () => recordSample("delayed-normal", observation("normal", NOW + 60_000)),
        () => recordSample("competing-stop", observation("hard_stop", NOW)),
      );
      expect(await storedState()).toMatchObject({
        action: "hard_stop",
        observed_at: new Date(NOW + 60_000).toISOString(),
        normal_streak: 1,
        release_pending: 0,
      });
      expect(await storedRun("delayed-normal")).toMatchObject({
        status: "completed",
        effective_action: "hard_stop",
      });
      expect(await storedRun("competing-stop")).toMatchObject({
        status: "completed",
        effective_action: "hard_stop",
      });
    },
  );

  it("releases a latch after two distinct normals committed in observation order", async () => {
    await seedStoredState({
      ...state("hard_stop", "2026-08-15T00:00:00.000Z"),
      period_end: "2026-09-15T00:00:00.000Z",
    });
    const firstAt = Date.parse("2026-09-16T02:00:00.000Z");
    await reserveTestRun("second-normal");
    await reserveTestRun("first-normal");
    await withPausedPublication(
      () =>
        recordSample(
          "second-normal",
          observation("normal", firstAt + 60_000, "2026-09-15T00:00:00.000Z"),
        ),
      async () => {
        await recordSample(
          "first-normal",
          observation("normal", firstAt, "2026-09-15T00:00:00.000Z"),
        );
        expect(await storedState()).toMatchObject({
          action: "hard_stop",
          normal_streak: 1,
          release_pending: 1,
        });
      },
    );
    expect(await storedState()).toMatchObject({
      action: "normal",
      normal_streak: 2,
      release_pending: 0,
    });
  });
});

describe("atomic usage guard evidence admission", () => {
  it("does not count identical evidence twice or alert for a duplicate", async () => {
    await seedStoredState({
      ...state("hard_stop", "2026-08-15T00:00:00.000Z"),
      period_end: "2026-09-15T00:00:00.000Z",
    });
    const capturedAt = Date.parse("2026-09-16T02:00:00.000Z");
    const sample = observation("normal", capturedAt, "2026-09-15T00:00:00.000Z");
    await reserveTestRun("normal-original");
    await recordSample("normal-original", sample);
    const original = await storedState();
    await reserveTestRun("normal-duplicate");
    await recordSample("normal-duplicate", sample, testEnv);
    expect(await storedState()).toEqual(original);
    expect(await storedRun("normal-duplicate")).toMatchObject({
      status: "completed",
      effective_action: "hard_stop",
      alert_status: "unchanged",
      error_code: null,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await reserveTestRun("normal-distinct");
    await recordSample(
      "normal-distinct",
      observation("normal", capturedAt + 60_000, "2026-09-15T00:00:00.000Z"),
    );
    expect(await storedState()).toMatchObject({
      action: "normal",
      normal_streak: 2,
      release_pending: 0,
    });
  });

  it.each(["equal-conflict", "older-stricter", "older-period", "changed-period-end"])(
    "fails a rejected run without changing current state or notifying: %s",
    async (kind) => {
      const capturedAt = Date.parse("2026-09-16T02:00:00.000Z");
      const current = observation("normal", capturedAt, "2026-09-15T00:00:00.000Z");
      await reserveTestRun("current");
      await recordSample("current", current);
      const original = await storedState();
      const rejected =
        kind === "older-period"
          ? observation("hard_stop", NOW)
          : observation(
              kind === "changed-period-end" ? "normal" : "hard_stop",
              kind === "equal-conflict"
                ? capturedAt
                : capturedAt + (kind === "older-stricter" ? -60_000 : 60_000),
              "2026-09-15T00:00:00.000Z",
              kind === "changed-period-end"
                ? "2026-10-16T00:00:00.000Z"
                : "2026-10-15T00:00:00.000Z",
            );
      await reserveTestRun("rejected");
      await recordSample("rejected", rejected, testEnv);
      expect(await storedState()).toEqual(original);
      expect(await storedRun("rejected")).toMatchObject({
        status: "failure",
        effective_action: "normal",
        alert_status: "unchanged",
        error_code: "usage_guard_evidence_rejected",
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );
});

describe("usage guard publication identity and notifications", () => {
  it.each([false, true])(
    "does not acknowledge newer evidence with a delayed same-action alert (rollover: %s)",
    async (rollover) => {
      const requested = deferred();
      const deliver = deferred();
      vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
        if (String(input) !== discordUrl()) throw new Error("unexpected_fetch");
        requested.resolve();
        await deliver.promise;
        return new Response(null, { status: 200 });
      });
      await reserveTestRun("old-alert");
      await reserveTestRun("new-evidence");
      const pending = recordSample("old-alert", observation("warning", NOW), testEnv);
      try {
        await requested.promise;
        await recordSample(
          "new-evidence",
          observation(
            "warning",
            rollover ? Date.parse("2026-09-16T02:00:00.000Z") : NOW + 60_000,
            rollover ? "2026-09-15T00:00:00.000Z" : "2026-08-15T00:00:00.000Z",
          ),
        );
        const current = await storedState();
        expect(current.last_alert_action).toBeNull();
        deliver.resolve();
        await pending;
        expect(await storedState()).toEqual(current);
        expect(await storedRun("old-alert")).toMatchObject({ alert_status: "sent" });
        expect(await storedRun("new-evidence")).toMatchObject({
          alert_status: "not_configured",
        });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      } finally {
        deliver.resolve();
        await pending;
      }
    },
  );

  it("does not notify when the delivered marker already matches the next latched action", async () => {
    const previous = {
      ...state("warning", "2026-08-15T00:00:00.000Z"),
      observed_at: new Date(NOW - 60_000).toISOString(),
      period_end: "2026-09-15T00:00:00.000Z",
      last_alert_action: "warning",
    };
    const sample = observation("normal", NOW);
    const expected = transitionAction(previous, sample.evidence);
    expect(expected).toEqual({
      action: "warning",
      normalStreak: 1,
      releasePending: false,
    });
    expect(actionAlertRequired(previous, expected.action)).toBe(false);
    await seedStoredState(previous);
    await reserveTestRun("already-delivered");
    await recordSample("already-delivered", sample, testEnv);
    const stored = await storedState();
    expect(stored).toMatchObject({
      action: "warning",
      observed_at: sample.evidence.observedAt,
      normal_streak: 1,
      release_pending: 0,
      last_alert_action: "warning",
    });
    expect(JSON.parse(stored.evidence_json)).toEqual(sample.evidence);
    expect(await storedRun("already-delivered")).toMatchObject({
      status: "completed",
      evaluated_action: "normal",
      effective_action: "warning",
      alert_status: "unchanged",
      error_code: null,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("sends a recovery alert when two-normal release replaces a delivered non-normal marker", async () => {
    const capturedAt = Date.parse("2026-09-16T02:00:00.000Z");
    const previous = {
      ...state("hard_stop", "2026-09-15T00:00:00.000Z", 1, true),
      observed_at: new Date(capturedAt - 60_000).toISOString(),
      period_end: "2026-10-15T00:00:00.000Z",
      last_alert_action: "hard_stop",
    };
    const sample = observation("normal", capturedAt, previous.period_start);
    const expected = transitionAction(previous, sample.evidence);
    expect(expected).toEqual({
      action: "normal",
      normalStreak: 2,
      releasePending: false,
    });
    expect(actionAlertRequired(previous, expected.action)).toBe(true);
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input) !== discordUrl()) throw new Error("unexpected_fetch");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        embeds: [{ title: "Cloudflare quota guard 복구" }],
      });
      return new Response(null, { status: 200 });
    });
    await seedStoredState(previous);
    await reserveTestRun("delivered-recovery");
    await recordSample("delivered-recovery", sample, testEnv);
    const stored = await storedState();
    expect(stored).toMatchObject({
      action: "normal",
      observed_at: sample.evidence.observedAt,
      normal_streak: 2,
      release_pending: 0,
      last_alert_action: "normal",
    });
    expect(JSON.parse(stored.evidence_json)).toEqual(sample.evidence);
    expect(await storedRun("delivered-recovery")).toMatchObject({
      status: "completed",
      evaluated_action: "normal",
      effective_action: "normal",
      alert_status: "sent",
      error_code: null,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an older overlapping period even when its observation is newer", async () => {
    const capturedAt = Date.parse("2026-09-16T02:00:00.000Z");
    const current = observation("normal", capturedAt, "2026-09-15T00:00:00.000Z");
    await reserveTestRun("current-period");
    await recordSample("current-period", current);
    const original = await storedState();
    expect(JSON.parse(original.evidence_json)).toEqual(current.evidence);
    const rejected = observation(
      "hard_stop",
      capturedAt + 60_000,
      "2026-08-15T00:00:00.000Z",
      "2026-10-15T00:00:00.000Z",
    );
    expect(Date.parse(rejected.evidence.observedAt)).toBeGreaterThan(capturedAt);
    expect(Date.parse(rejected.evidence.plan.periodStart)).toBeLessThan(
      Date.parse(current.evidence.plan.periodStart),
    );
    await reserveTestRun("older-overlapping-period");
    await recordSample("older-overlapping-period", rejected, testEnv);
    expect(await storedState()).toEqual(original);
    expect(await storedRun("older-overlapping-period")).toMatchObject({
      status: "failure",
      evaluated_action: "hard_stop",
      effective_action: "normal",
      alert_status: "unchanged",
      error_code: "usage_guard_evidence_rejected",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("acknowledges a successfully delivered alert for the accepted evidence", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      if (String(input) !== discordUrl()) throw new Error("unexpected_fetch");
      return new Response(null, { status: 200 });
    });
    await reserveTestRun("accepted-alert");
    await recordSample("accepted-alert", observation("warning", NOW), testEnv);
    expect(await storedState()).toMatchObject({ last_alert_action: "warning" });
    expect(await storedRun("accepted-alert")).toMatchObject({ alert_status: "sent" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
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
    .bind(runId, new Date(NOW).toISOString(), new Date(NOW).toISOString(), testEnv.DEPLOY_SHA)
    .run();
}

async function seedStoredState(previous: StoredGuardState) {
  await testEnv.GUARD_DB.prepare(
    `INSERT INTO usage_guard_state (
       singleton_id, action, observed_at, period_start, period_end,
       evidence_json, evidence_hash, current_percent, projected_percent,
       governing_metric, normal_streak, release_pending, last_alert_action, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      previous.action,
      previous.observed_at,
      previous.period_start,
      previous.period_end,
      previous.evidence_json,
      previous.evidence_hash,
      previous.current_percent,
      previous.projected_percent,
      previous.governing_metric,
      previous.normal_streak,
      previous.release_pending,
      previous.last_alert_action,
      previous.observed_at,
    )
    .run();
}

async function storedState() {
  const row = await testEnv.GUARD_DB.prepare(
    "SELECT * FROM usage_guard_state WHERE singleton_id = 1",
  ).first<StoredGuardState & { updated_at: string }>();
  if (!row) throw new Error("test_state_missing");
  return row;
}

async function storedRun(runId: string) {
  return testEnv.GUARD_DB.prepare("SELECT * FROM usage_guard_runs WHERE run_id = ?")
    .bind(runId)
    .first<Record<string, unknown>>();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withPausedPublication(delayed: () => Promise<void>, competing: () => Promise<void>) {
  const ready = deferred();
  const proceed = deferred();
  const batch = testEnv.GUARD_DB.batch.bind(testEnv.GUARD_DB);
  const spy = vi.spyOn(testEnv.GUARD_DB, "batch").mockImplementationOnce(async (statements) => {
    ready.resolve();
    await proceed.promise;
    return batch(statements);
  });
  const pending = delayed();
  try {
    await ready.promise;
    await competing();
    proceed.resolve();
    await pending;
  } finally {
    proceed.resolve();
    await pending;
    spy.mockRestore();
  }
}

function discordUrl() {
  return `https://discord.com/api/v10/channels/${testEnv.DISCORD_ALERT_CHANNEL_ID}/messages`;
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
