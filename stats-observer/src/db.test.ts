import { reset } from "cloudflare:test";
import { env as bindings } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import observerSchema from "../schema.sql?raw";
import { failRun, finishRun, markAlertRetry, markAlertSent } from "./db";
import { runObserver } from "./observer";
import type { ObserverAlertRow, StatsObserverEnv } from "./types";

const env = bindings as StatsObserverEnv;

// No row matches these identifiers, so each guarded UPDATE applies zero changes: the
// exact condition a real "write silently did not apply" would produce in D1.
const UNMATCHED_RUN_ID = "obs-staging-unmatched";
const UNMATCHED_ALERT = { fingerprint: "c".repeat(64) } as ObserverAlertRow;

beforeEach(async () => {
  await reset();
  for (const statement of observerSchema
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean))
    await bindings.OBSERVER_DB.prepare(statement).run();
});

describe("stats observer unapplied-write reporting", () => {
  it("records a completion whose guarded update matched no run row", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await finishRun(env, UNMATCHED_RUN_ID, { rows: 1, deltas: 1, alerts: 0 });

    expect(errorLog.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
      event: "observer_run_completion_not_recorded",
      changes: 0,
      runId: UNMATCHED_RUN_ID,
    });
    errorLog.mockRestore();
  });

  it("records a delivered alert whose sent marker matched no alert row", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await markAlertSent(env, UNMATCHED_ALERT, "987654321098765432", new Date().toISOString());

    expect(errorLog.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
      event: "observer_alert_sent_marker_not_recorded",
      changes: 0,
      fingerprint: "c".repeat(64),
    });
    errorLog.mockRestore();
  });

  it("stays quiet when the guarded updates do apply", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = new Date().toISOString();
    await bindings.OBSERVER_DB.prepare(
      `INSERT INTO observer_runs (run_id, scheduled_at, started_at, status, deployment_sha)
       VALUES (?1, ?2, ?2, 'running', ?3)`,
    )
      .bind(UNMATCHED_RUN_ID, now, "a".repeat(40))
      .run();
    await bindings.OBSERVER_DB.prepare(
      `INSERT INTO observer_alerts
       (fingerprint, source_kind, severity, error_code, context_json, first_seen,
        last_seen, window_started_at, window_count, total_count, updated_at)
       VALUES (?1, 'solver_failure', 'critical', 'memo_full', '{}', ?2, ?2, ?2, 1, 1, ?2)`,
    )
      .bind(UNMATCHED_ALERT.fingerprint, now)
      .run();

    await finishRun(env, UNMATCHED_RUN_ID, { rows: 1, deltas: 1, alerts: 0 });
    await markAlertSent(env, UNMATCHED_ALERT, "987654321098765432", now);

    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });
});

describe("stats observer persisted error codes", () => {
  it("stores the registry's persisted output as is, including the fixed D1 category", async () => {
    const now = new Date().toISOString();
    await bindings.OBSERVER_DB.prepare(
      `INSERT INTO observer_runs (run_id, scheduled_at, started_at, status, deployment_sha)
       VALUES (?1, ?2, ?2, 'running', ?3)`,
    )
      .bind(UNMATCHED_RUN_ID, now, "a".repeat(40))
      .run();
    await bindings.OBSERVER_DB.prepare(
      `INSERT INTO observer_alerts
       (fingerprint, source_kind, severity, error_code, context_json, first_seen,
        last_seen, window_started_at, window_count, total_count, updated_at)
       VALUES (?1, 'solver_failure', 'critical', 'memo_full', '{}', ?2, ?2, ?2, 1, 1, ?2)`,
    )
      .bind(UNMATCHED_ALERT.fingerprint, now)
      .run();

    // No shape check rewrites these: the column type is the registry's persisted output.
    await failRun(env, UNMATCHED_RUN_ID, "D1_ERROR");
    await markAlertRetry(env, UNMATCHED_ALERT.fingerprint, "discord_429", null);

    expect(
      await bindings.OBSERVER_DB.prepare(
        "SELECT status, error_code FROM observer_runs WHERE run_id = ?",
      )
        .bind(UNMATCHED_RUN_ID)
        .first(),
    ).toEqual({ status: "failure", error_code: "D1_ERROR" });
    expect(
      await bindings.OBSERVER_DB.prepare(
        "SELECT send_status, last_send_error FROM observer_alerts WHERE fingerprint = ?",
      )
        .bind(UNMATCHED_ALERT.fingerprint)
        .first(),
    ).toEqual({ send_status: "failed", last_send_error: "discord_429" });
  });

  it("records the Observer fallback, never a runtime error name, for an unregistered failure", async () => {
    // A guard binding that is not a D1 database fails the poll with a TypeError.
    const broken: StatsObserverEnv = {
      ...env,
      GUARD_DB: {} as D1Database,
      ENVIRONMENT: "staging",
      DEPLOY_SHA: "a".repeat(40),
    };
    const now = Date.parse("2026-09-02T12:00:00.000Z");

    await expect(runObserver(broken, now, { now: () => now })).rejects.toThrow(TypeError);

    expect(
      await bindings.OBSERVER_DB.prepare("SELECT status, error_code FROM observer_runs").first(),
    ).toEqual({ status: "failure", error_code: "observer_internal_error" });
  });
});
