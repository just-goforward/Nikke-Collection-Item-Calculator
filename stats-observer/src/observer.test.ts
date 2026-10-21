import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import statsSchema from "../../cloudflare/schema.sql?raw";
import {
  buildMetricEvidence,
  CLOUDFLARE_PAID_INCLUDED_LIMITS,
  CLOUDFLARE_PAID_THRESHOLDS,
  D1_DATABASE_IDS,
  type D1QuotaEvidence,
} from "../../shared/d1QuotaEvidence";
import observerSchema from "../schema.sql?raw";
import { identityCollisionKeys, runObserver } from "./observer";
import type { SourceObservation, StatsObserverEnv } from "./types";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

describe("stats observer D1 integration", () => {
  beforeEach(async () => {
    await reset();
    await applySql(env.STATS_DB, statsSchema);
    await applySql(env.OBSERVER_DB, observerSchema);
    await seedGuard(env.GUARD_DB, NOW);
  });

  it("baselines existing failures without alerting and sends only the later positive delta", async () => {
    await insertFailure(1, Math.floor((NOW - 2 * 60 * 60_000) / 1_000));
    const fetchImpl = vi.fn<typeof fetch>();

    const baseline = await runObserver(observerEnv(), NOW, { fetchImpl, now: () => NOW });
    expect(baseline).toMatchObject({ baselineInitialized: true });
    expect(fetchImpl).not.toHaveBeenCalled();

    await env.STATS_DB.prepare(
      "UPDATE solver_failure_aggregates_game_day SET events = 2, last_seen = ?",
    )
      .bind(Math.floor((NOW + 30 * 60_000) / 1_000))
      .run();
    fetchImpl.mockResolvedValueOnce(Response.json({ id: "987654321098765432" }));

    await runObserver(observerEnv(), NOW + 30 * 60_000, {
      fetchImpl,
      now: () => NOW + 30 * 60_000,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = fetchImpl.mock.calls[0];
    const body = JSON.parse(String(request?.[1]?.body)) as {
      allowed_mentions?: { parse?: unknown[] };
      embeds?: Array<{ description?: string }>;
    };
    expect(body.allowed_mentions?.parse).toEqual([]);
    expect(body.embeds?.[0]?.description).toContain("500_plus/300_349/150_199");
    expect(body.embeds?.[0]?.description).not.toContain("720");
    const alert = await env.OBSERVER_DB.prepare(
      "SELECT severity, window_count, total_count, send_status FROM observer_alerts",
    ).first<Record<string, unknown>>();
    expect(alert).toMatchObject({
      severity: "warning",
      window_count: 1,
      total_count: 1,
      send_status: "sent",
    });
  });

  it("records a failed invocation when the usage guard rejects the poll", async () => {
    await seedGuard(env.GUARD_DB, NOW - 2 * 60 * 60_000);

    await expect(runObserver(observerEnv(), NOW, { now: () => NOW })).rejects.toThrow(
      "telemetry_budget_disabled",
    );

    const run = await env.OBSERVER_DB.prepare(
      `SELECT status, error_code, deployment_sha
       FROM observer_runs`,
    ).first<Record<string, unknown>>();
    expect(run).toMatchObject({
      status: "failure",
      error_code: "telemetry_budget_disabled",
      deployment_sha: "a".repeat(40),
    });
  });

  it("does not advance a source cursor when alert persistence fails", async () => {
    await insertFailure(0, Math.floor(NOW / 1_000));
    await runObserver(observerEnv(), NOW, { now: () => NOW });
    await env.STATS_DB.prepare(
      "UPDATE solver_failure_aggregates_game_day SET events = 1, last_seen = ?",
    )
      .bind(Math.floor((NOW + 60_000) / 1_000))
      .run();
    await env.OBSERVER_DB.exec(
      "CREATE TRIGGER fail_observer_alert BEFORE INSERT ON observer_alerts BEGIN SELECT RAISE(ABORT, 'forced alert failure'); END;",
    );

    await expect(
      runObserver(observerEnv(), NOW + 60_000, { now: () => NOW + 60_000 }),
    ).rejects.toThrow();
    const cursorAfterFailure = await env.OBSERVER_DB.prepare(
      "SELECT last_events FROM observer_source_cursors WHERE source_kind='solver_failure'",
    ).first<{ last_events: number }>();
    expect(cursorAfterFailure?.last_events).toBe(0);

    await env.OBSERVER_DB.exec("DROP TRIGGER fail_observer_alert;");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "987654321098765432" }));
    await runObserver(observerEnv(), NOW + 2 * 60_000, {
      fetchImpl,
      now: () => NOW + 2 * 60_000,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const cursorAfterRetry = await env.OBSERVER_DB.prepare(
      "SELECT last_events FROM observer_source_cursors WHERE source_kind='solver_failure'",
    ).first<{ last_events: number }>();
    expect(cursorAfterRetry?.last_events).toBe(1);
  });

  it("isolates a malformed source count and emits a critical integrity alert", async () => {
    await insertFailure(0, Math.floor(NOW / 1_000));
    await runObserver(observerEnv(), NOW, { now: () => NOW });
    await env.STATS_DB.prepare(
      "UPDATE solver_failure_aggregates_game_day SET events = 'invalid', last_seen = ?",
    )
      .bind(Math.floor((NOW + 60_000) / 1_000))
      .run();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "987654321098765432" }));

    const tracked = trackedEnv();
    await runObserver(tracked.env, NOW + 60_000, {
      fetchImpl,
      now: () => NOW + 60_000,
    });

    const alert = await env.OBSERVER_DB.prepare(
      "SELECT source_kind,severity,error_code FROM observer_alerts",
    ).first<Record<string, unknown>>();
    expect(alert).toMatchObject({
      source_kind: "observer_integrity",
      severity: "critical",
      error_code: "observer_invalid_count",
    });
    const cursor = await env.OBSERVER_DB.prepare(
      "SELECT last_events FROM observer_source_cursors WHERE source_kind='solver_failure'",
    ).first<{ last_events: number }>();
    expect(cursor?.last_events).toBe(0);
    expect(tracked.observer.calls.filter((call) => call.kind === "batch")[0]?.sql.length).toBe(2);
  });

  it("rebaselines a decreased count and alerts without blocking the poll", async () => {
    await insertFailure(2, Math.floor(NOW / 1_000));
    await runObserver(observerEnv(), NOW, { now: () => NOW });
    await env.STATS_DB.prepare(
      "UPDATE solver_failure_aggregates_game_day SET events = 1, last_seen = ?",
    )
      .bind(Math.floor((NOW + 60_000) / 1_000))
      .run();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "987654321098765432" }));

    await runObserver(observerEnv(), NOW + 60_000, {
      fetchImpl,
      now: () => NOW + 60_000,
    });

    const alert = await env.OBSERVER_DB.prepare(
      "SELECT source_kind,severity,error_code FROM observer_alerts",
    ).first<Record<string, unknown>>();
    expect(alert).toMatchObject({
      source_kind: "observer_integrity",
      severity: "critical",
      error_code: "observer_count_decrease",
    });
    const cursor = await env.OBSERVER_DB.prepare(
      "SELECT last_events FROM observer_source_cursors WHERE source_kind='solver_failure'",
    ).first<{ last_events: number }>();
    expect(cursor?.last_events).toBe(1);
  });

  it("detects different identities assigned to the same source row hash", () => {
    const observation = {
      sourceKind: "solver_failure",
    } as SourceObservation;
    const collisions = identityCollisionKeys([
      { observation, canonicalIdentity: '{"id":"one"}', rowHash: "a".repeat(64) },
      { observation, canonicalIdentity: '{"id":"two"}', rowHash: "a".repeat(64) },
    ]);

    expect(collisions).toEqual(new Set([`solver_failure:${"a".repeat(64)}`]));
  });

  it("escalates a capacity fingerprint on the third new event", async () => {
    await insertFailure(0, Math.floor(NOW / 1_000));
    await runObserver(observerEnv(), NOW, { now: () => NOW });
    await env.STATS_DB.prepare(
      "UPDATE solver_failure_aggregates_game_day SET events = 3, last_seen = ?",
    )
      .bind(Math.floor((NOW + 60_000) / 1_000))
      .run();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "987654321098765432" }));

    await runObserver(observerEnv(), NOW + 60_000, {
      fetchImpl,
      now: () => NOW + 60_000,
    });

    const alert = await env.OBSERVER_DB.prepare(
      "SELECT severity, window_count, total_count FROM observer_alerts",
    ).first<Record<string, unknown>>();
    expect(alert).toMatchObject({ severity: "critical", window_count: 3, total_count: 3 });
  });

  it("stores Discord retry_after instead of sleeping in the invocation", async () => {
    await insertFailure(0, Math.floor(NOW / 1_000));
    await runObserver(observerEnv(), NOW, { now: () => NOW });
    await env.STATS_DB.prepare(
      "UPDATE solver_failure_aggregates_game_day SET events = 1, last_seen = ?",
    )
      .bind(Math.floor((NOW + 60_000) / 1_000))
      .run();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ retry_after: 65 }, { status: 429 }));

    await runObserver(observerEnv(), NOW + 60_000, {
      fetchImpl,
      now: () => NOW + 60_000,
    });

    const alert = await env.OBSERVER_DB.prepare(
      "SELECT next_send_at, send_status, last_send_error FROM observer_alerts",
    ).first<Record<string, unknown>>();
    expect(alert).toMatchObject({
      next_send_at: new Date(NOW + 60_000 + 65_000).toISOString(),
      send_status: "pending",
      last_send_error: "discord_429",
    });
  });

  it("keeps a non-retryable Discord failure as a durable unsent alert", async () => {
    await insertFailure(0, Math.floor(NOW / 1_000));
    await runObserver(observerEnv(), NOW, { now: () => NOW });
    await env.STATS_DB.prepare(
      "UPDATE solver_failure_aggregates_game_day SET events = 1, last_seen = ?",
    )
      .bind(Math.floor((NOW + 60_000) / 1_000))
      .run();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));

    await runObserver(observerEnv(), NOW + 60_000, {
      fetchImpl,
      now: () => NOW + 60_000,
    });

    const alert = await env.OBSERVER_DB.prepare(
      "SELECT next_send_at, send_status, last_send_error FROM observer_alerts",
    ).first<Record<string, unknown>>();
    expect(alert).toMatchObject({
      next_send_at: null,
      send_status: "failed",
      last_send_error: "discord_403",
    });
  });

  it("sends a separate recovery only after a later runtime window proves zero errors", async () => {
    await runObserver(observerEnv(), NOW, { now: () => NOW });
    await seedGuard(env.GUARD_DB, NOW + 30 * 60_000, 1);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "111111111111111111" }))
      .mockResolvedValueOnce(Response.json({ id: "222222222222222222" }));

    await runObserver(observerEnv(), NOW + 30 * 60_000, {
      fetchImpl,
      now: () => NOW + 30 * 60_000,
    });
    await seedGuard(env.GUARD_DB, NOW + 60 * 60_000, 0);
    await runObserver(observerEnv(), NOW + 60 * 60_000, {
      fetchImpl,
      now: () => NOW + 60 * 60_000,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      nonce: string;
      embeds: Array<{ title: string }>;
    };
    const second = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as {
      nonce: string;
      embeds: Array<{ title: string }>;
    };
    expect(first.embeds[0]?.title).toBe("Solver 운영 오류");
    expect(second.embeds[0]?.title).toBe("Solver 운영 복구");
    expect(second.nonce).not.toBe(first.nonce);
    const alert = await env.OBSERVER_DB.prepare(
      "SELECT state,send_status FROM observer_alerts WHERE source_kind='worker_runtime' AND error_code='worker_runtime_error'",
    ).first<Record<string, unknown>>();
    expect(alert).toMatchObject({ state: "resolved", send_status: "sent" });
  });

  it("associates missing and existing cursors and alert states across source kinds", async () => {
    const seconds = Math.floor(NOW / 1_000);
    const existingRevision = "b".repeat(40);
    const missingRevision = "a".repeat(40);
    await env.STATS_DB.batch([
      ...sourceStatements(existingRevision, 7, seconds),
      failureStatement(2, seconds, "d".repeat(40)),
    ]);
    await runObserver(observerEnv(), NOW, { now: () => NOW });
    const existingFingerprint = await failureFingerprint(existingRevision);
    const now = new Date(NOW).toISOString();
    await env.OBSERVER_DB.prepare(
      `INSERT INTO observer_alerts
       (fingerprint, source_kind, severity, error_code, context_json, first_seen,
        last_seen, window_started_at, window_count, total_count, updated_at)
       VALUES (?, 'solver_failure', 'critical', 'memo_full', '{}', ?, ?, ?, 4, 4, ?)`,
    )
      .bind(existingFingerprint, now, now, now, now)
      .run();
    const later = seconds + 60;
    await env.STATS_DB.batch([
      failureStatement(1, seconds, missingRevision),
      sourceStatements(missingRevision, 2, seconds)[1],
      env.STATS_DB.prepare(
        "UPDATE solver_failure_aggregates_game_day SET events=10,last_seen=? WHERE app_revision=?",
      ).bind(later, existingRevision),
      env.STATS_DB.prepare(
        "UPDATE stats_delivery_health_aggregates_game_day SET events=9,last_seen=? WHERE app_revision=?",
      ).bind(later, existingRevision),
    ]);
    const tracked = trackedEnv();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ id: "987654321098765432" }));
    const result = await runObserver(tracked.env, NOW + 60_000, {
      fetchImpl,
      now: () => NOW + 60_000,
    });

    expect(result).toEqual({ rows: 8, deltas: 8, alerts: 4 });
    expect(
      await env.OBSERVER_DB.prepare(
        "SELECT total_count,window_count,severity FROM observer_alerts WHERE fingerprint=?",
      )
        .bind(existingFingerprint)
        .first(),
    ).toEqual({ total_count: 7, window_count: 7, severity: "critical" });
    expect(
      await env.OBSERVER_DB.prepare("SELECT total_count FROM observer_alerts WHERE fingerprint=?")
        .bind(await failureFingerprint(missingRevision))
        .first(),
    ).toEqual({ total_count: 1 });
    const otherAlerts = await env.OBSERVER_DB.prepare(
      `SELECT source_kind,total_count FROM observer_alerts
       WHERE source_kind != 'solver_failure' ORDER BY source_kind`,
    ).all();
    expect(otherAlerts.results).toEqual([
      { source_kind: "delivery_health", total_count: 2 },
      { source_kind: "submission_rejection", total_count: 2 },
    ]);
    const cursorCounts = await env.OBSERVER_DB.prepare(
      "SELECT last_events FROM observer_source_cursors ORDER BY last_events",
    ).all<{ last_events: number }>();
    expect(cursorCounts.results.map((row) => row.last_events)).toEqual([0, 0, 1, 2, 2, 7, 9, 10]);
    expect(tracked.calls().length).toBe(10 + 1 + 1 + 4);
    expect(
      tracked.observer.calls.filter((call) => call.kind === "batch").map((call) => call.sql.length),
    ).toEqual([8, 4, 13]);
  });

  it("preserves the entire 1502-row domain and counts binding calls separately from statements", async () => {
    const seconds = Math.floor(NOW / 1_000);
    await seedSources(500, 7, seconds);
    const baseline = trackedEnv();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ id: "987654321098765432" }));
    expect(await runObserver(baseline.env, NOW, { fetchImpl, now: () => NOW })).toEqual({
      baselineInitialized: true,
      rows: 1502,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(baseline.calls().length).toBe(9);
    expect(baseline.statements()).toBe(9 + 1502);
    expect(baseline.observer.calls.filter((call) => call.kind === "batch")[0]?.sql.length).toBe(
      1503,
    );
    expect(
      await env.OBSERVER_DB.prepare(
        "SELECT COUNT(*) AS count FROM observer_source_cursors",
      ).first(),
    ).toEqual({ count: 1502 });

    await updateSources(10, seconds + 60);
    await seedGuard(env.GUARD_DB, NOW + 60_000, 1, 1);
    const delta = trackedEnv();
    expect(
      await runObserver(delta.env, NOW + 60_000, {
        fetchImpl,
        now: () => NOW + 60_000,
      }),
    ).toEqual({ rows: 1502, deltas: 4502, alerts: 20 });
    // C=1502 cursor reads, P=1502 pending states, R=0 recoveries, A=20 deliveries.
    // Binding calls: 10 + I(C>0) + I(P>0) + A + S + X.
    expect(delta.guard.calls.length).toBe(2);
    expect(delta.stats.calls.length).toBe(3);
    expect(delta.calls().length).toBe(10 + 1 + 1 + 20);
    // SQL statements are unchanged: 10 + C + 2P + R + N + A + S + X.
    expect(delta.statements()).toBe(10 + 1502 + 2 * 1502 + 1502 + 20);
    expect(
      delta.observer.calls.filter((call) => call.kind === "batch").map((call) => call.sql.length),
    ).toEqual([1502, 1502, 3005]);
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    const totals = await env.OBSERVER_DB.prepare(
      "SELECT source_kind,SUM(total_count) AS total FROM observer_alerts GROUP BY source_kind ORDER BY source_kind",
    ).all();
    expect(totals.results).toEqual([
      { source_kind: "delivery_health", total: 1500 },
      { source_kind: "solver_failure", total: 1500 },
      { source_kind: "submission_rejection", total: 1500 },
      { source_kind: "worker_runtime", total: 2 },
    ]);

    await env.OBSERVER_DB.prepare(
      `CREATE TRIGGER fail_sent_marker BEFORE UPDATE ON observer_alerts
       WHEN NEW.send_status='sent'
       BEGIN SELECT RAISE(ABORT, 'forced marker failure'); END;`,
    ).run();
    await env.OBSERVER_DB.prepare(
      `CREATE TRIGGER fail_completed_run BEFORE UPDATE ON observer_runs
       WHEN NEW.status='completed'
       BEGIN SELECT RAISE(ABORT, 'forced completion failure'); END;`,
    ).run();
    await updateSources(13, seconds + 120);
    await seedGuard(env.GUARD_DB, NOW + 120_000, 2, 1);
    fetchImpl.mockClear();
    const failure = trackedEnv();
    await expect(
      runObserver(failure.env, NOW + 120_000, {
        fetchImpl,
        now: () => NOW + 120_000,
      }),
    ).rejects.toThrow();
    // All 20 success markers fail, each gets a retry marker; finish fails, then failRun runs.
    expect(failure.calls().length).toBe(10 + 1 + 1 + 20 + 20 + 1);
    expect(failure.statements()).toBe(10 + 1502 + 2 * 1501 + 1502 + 20 + 20 + 1);
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    expect(failure.calls().length + fetchImpl.mock.calls.length).toBe(73);
    expect(
      await env.OBSERVER_DB.prepare("SELECT status FROM observer_runs WHERE scheduled_at=?")
        .bind(new Date(NOW + 120_000).toISOString())
        .first(),
    ).toEqual({ status: "failure" });
  });

  it("rolls back a failed baseline transaction and retries silently in a later run", async () => {
    await insertFailure(7, Math.floor(NOW / 1_000));
    await env.OBSERVER_DB.prepare(
      `CREATE TRIGGER fail_baseline BEFORE UPDATE ON observer_state
       WHEN NEW.baseline_initialized=1
       BEGIN SELECT RAISE(ABORT, 'forced baseline failure'); END;`,
    ).run();
    const tracked = trackedEnv();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(runObserver(tracked.env, NOW, { fetchImpl, now: () => NOW })).rejects.toThrow();
    expect(tracked.calls().length).toBe(9);
    expect(
      await env.OBSERVER_DB.prepare(
        "SELECT COUNT(*) AS count FROM observer_source_cursors",
      ).first(),
    ).toEqual({ count: 0 });
    expect(
      await env.OBSERVER_DB.prepare("SELECT baseline_initialized FROM observer_state").first(),
    ).toEqual({ baseline_initialized: 0 });
    await env.OBSERVER_DB.exec("DROP TRIGGER fail_baseline;");
    expect(
      await runObserver(observerEnv(), NOW + 60_000, {
        fetchImpl,
        now: () => NOW + 60_000,
      }),
    ).toEqual({ baselineInitialized: true, rows: 3 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rolls back alerts, recovery and cursors together when the final poll write fails", async () => {
    await insertFailure(7, Math.floor(NOW / 1_000));
    await runObserver(observerEnv(), NOW, { now: () => NOW });
    await seedGuard(env.GUARD_DB, NOW + 60_000, 1);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ id: "987654321098765432" }));
    await runObserver(observerEnv(), NOW + 60_000, {
      fetchImpl,
      now: () => NOW + 60_000,
    });
    await env.STATS_DB.prepare(
      "UPDATE solver_failure_aggregates_game_day SET events=10,last_seen=?",
    )
      .bind(Math.floor((NOW + 120_000) / 1_000))
      .run();
    await seedGuard(env.GUARD_DB, NOW + 120_000, 0);
    await env.OBSERVER_DB.prepare(
      `CREATE TRIGGER fail_poll BEFORE UPDATE ON observer_state
       BEGIN SELECT RAISE(ABORT, 'forced poll failure'); END;`,
    ).run();
    const tracked = trackedEnv();
    await expect(
      runObserver(tracked.env, NOW + 120_000, {
        fetchImpl,
        now: () => NOW + 120_000,
      }),
    ).rejects.toThrow();
    expect(tracked.calls().length).toBe(11);
    expect(tracked.observer.calls.filter((call) => call.kind === "batch")[2]?.sql.length).toBe(6);
    const cursors = await env.OBSERVER_DB.prepare(
      "SELECT source_kind,last_events FROM observer_source_cursors ORDER BY source_kind,last_events",
    ).all();
    expect(cursors.results).toEqual([
      { source_kind: "solver_failure", last_events: 7 },
      { source_kind: "worker_runtime", last_events: 0 },
      { source_kind: "worker_runtime", last_events: 1 },
    ]);
    const alerts = await env.OBSERVER_DB.prepare(
      "SELECT source_kind,state,send_status,total_count FROM observer_alerts",
    ).all();
    expect(alerts.results).toEqual([
      { source_kind: "worker_runtime", state: "open", send_status: "sent", total_count: 1 },
    ]);
    await env.OBSERVER_DB.exec("DROP TRIGGER fail_poll;");
    fetchImpl.mockClear();
    expect(
      await runObserver(observerEnv(), NOW + 180_000, {
        fetchImpl,
        now: () => NOW + 180_000,
      }),
    ).toEqual({ rows: 3, deltas: 3, alerts: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps the invocation error authoritative when the failure record itself cannot be written", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await env.OBSERVER_DB.prepare(
      `CREATE TRIGGER fail_failure_record BEFORE UPDATE ON observer_runs
       WHEN NEW.status='failure'
       BEGIN SELECT RAISE(ABORT, 'forced failure-record failure'); END;`,
    ).run();
    await seedGuard(env.GUARD_DB, NOW - 2 * 60 * 60_000);

    // The poll error still propagates, and the broken failure record is separately logged.
    await expect(runObserver(observerEnv(), NOW, { now: () => NOW })).rejects.toThrow(
      "telemetry_budget_disabled",
    );
    expect(errorLog.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
      expect.objectContaining({ event: "observer_run_failure_record_failed" }),
    );
    errorLog.mockRestore();
  });

  it.each([
    [0, false],
    [1, false],
    [2, false],
    [0, true],
    [1, true],
    [2, true],
  ] as const)("fails closed on source %i overflow with baseline=%s", async (source, baseline) => {
    if (baseline) await runObserver(observerEnv(), NOW, { now: () => NOW });
    const seconds = Math.floor(NOW / 1_000);
    await seedSources(500, 1, seconds);
    await sourceStatements("f".repeat(40), 1, seconds)[source].run();
    const tracked = trackedEnv();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      runObserver(tracked.env, NOW + 60_000, {
        fetchImpl,
        now: () => NOW + 60_000,
      }),
    ).rejects.toThrow("observer_source_overflow");
    expect(tracked.calls().length).toBe(8);
    expect(tracked.observer.calls.some((call) => call.kind === "batch")).toBe(false);
    expect(
      await env.OBSERVER_DB.prepare(
        "SELECT COUNT(*) AS count FROM observer_source_cursors",
      ).first(),
    ).toEqual({ count: baseline ? 2 : 0 });
    expect(
      await env.OBSERVER_DB.prepare("SELECT COUNT(*) AS count FROM observer_alerts").first(),
    ).toEqual({ count: 0 });
    expect(
      await env.OBSERVER_DB.prepare("SELECT baseline_initialized FROM observer_state").first(),
    ).toEqual({ baseline_initialized: baseline ? 1 : 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["hard_stop", "stale", "hash_mismatch", "invalid_evidence"])(
    "keeps negative guard evidence %s ahead of all optional reads and writes",
    async (condition) => {
      if (condition === "hard_stop") {
        await env.GUARD_DB.prepare("UPDATE usage_guard_state SET action='hard_stop'").run();
      } else if (condition === "stale") {
        await seedGuard(env.GUARD_DB, NOW - 45 * 60_000);
      } else if (condition === "hash_mismatch") {
        await env.GUARD_DB.prepare("UPDATE usage_guard_state SET evidence_hash=?")
          .bind("f".repeat(64))
          .run();
      } else {
        const json = JSON.stringify({ ...quotaEvidence(NOW), version: 1 });
        await env.GUARD_DB.prepare("UPDATE usage_guard_state SET evidence_json=?,evidence_hash=?")
          .bind(json, await sha256(json))
          .run();
      }
      const tracked = trackedEnv();
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(runObserver(tracked.env, NOW, { fetchImpl, now: () => NOW })).rejects.toThrow();
      expect(tracked.stats.calls).toEqual([]);
      expect(tracked.observer.calls.map((call) => call.kind)).toEqual(["run", "run"]);
      expect(tracked.guard.calls.length).toBe(
        condition === "hard_stop" || condition === "stale" ? 1 : 2,
      );
      expect(await env.OBSERVER_DB.prepare("SELECT status FROM observer_runs").first()).toEqual({
        status: "failure",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});

function observerEnv(): StatsObserverEnv {
  return {
    STATS_DB: env.STATS_DB,
    OBSERVER_DB: env.OBSERVER_DB,
    GUARD_DB: env.GUARD_DB,
    ENVIRONMENT: "staging",
    DEPLOY_SHA: "a".repeat(40),
    DISCORD_BOT_TOKEN: "test-discord-token",
    DISCORD_ALERT_CHANNEL_ID: "123456789012345678",
  };
}

async function insertFailure(events: number, now: number) {
  await failureStatement(events, now).run();
}

function failureStatement(events: number, now: number, revision = "a".repeat(40)) {
  return env.STATS_DB.prepare(
    `INSERT INTO solver_failure_aggregates_game_day
      (date_key, recovery_version, policy_version, app_revision, ingest_revision,
       forecast_id, forecast_profile_id, rust_min_ef_solver_version,
       rust_phase2_solver_version, js_phase2_solver_version, requested_backend,
       min_ef_exit, phase2_exit, js_exit, terminal_backend, grade, level, exp_bucket,
       stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow, browser,
       browser_major, os, os_major, device_type, events, first_seen, last_seen)
     VALUES ('2026-09-02', 2, 'ladder_v2', ?, ?, 'supply-test', 'supply-test@fixed',
       'rust-min', 'rust-phase2', 'js-phase2', 'rust-min-ef', 'memo_full',
       'not_attempted', 'not_attempted', 'none', 'R', 0, 0, '500_plus',
       '300_349', '150_199', 'Chrome', '140', 'Android', '17', 'mobile', ?, ?, ?)`,
  ).bind(revision, "b".repeat(40), events, now, now);
}

function sourceStatements(revision: string, events: number, now: number) {
  return [
    failureStatement(events, now, revision),
    env.STATS_DB.prepare(
      `INSERT INTO stats_submission_rejection_aggregates_game_day
       (date_key,rejection_code,event_kind,recovery_version,policy_version,app_revision,
        events,first_seen,last_seen)
       VALUES ('2026-09-02','invalid_contract','solver_recovery','2','ladder_v2',?,?,?,?)`,
    ).bind(revision, events, now, now),
    env.STATS_DB.prepare(
      `INSERT INTO stats_delivery_health_aggregates_game_day
       (date_key,outcome,event_kind,attempts_bucket,age_bucket,last_failure_class,
        app_revision,events,first_seen,last_seen)
       VALUES ('2026-09-02','retried_success','solver_recovery','3_5','5m_15m',
        'network',?,?,?,?)`,
    ).bind(revision, events, now, now),
  ] as const;
}

async function seedSources(count: number, events: number, now: number) {
  await env.STATS_DB.batch(
    Array.from({ length: count }, (_, index) =>
      sourceStatements(index.toString(16).padStart(40, "0"), events, now),
    ).flat(),
  );
}

async function updateSources(events: number, now: number) {
  await env.STATS_DB.batch(
    [
      "solver_failure_aggregates_game_day",
      "stats_submission_rejection_aggregates_game_day",
      "stats_delivery_health_aggregates_game_day",
    ].map((table) =>
      env.STATS_DB.prepare(`UPDATE ${table} SET events=?,last_seen=?`).bind(events, now),
    ),
  );
}

function failureFingerprint(revision: string) {
  return sha256(
    JSON.stringify({
      appRevision: revision,
      environment: "staging",
      exitChain: "memo_full>not_attempted>not_attempted",
      forecastId: "supply-test",
      policyVersion: "ladder_v2",
      requestedBackend: "rust-min-ef",
      source: "solver_failure",
      terminalBackend: "none",
    }),
  );
}

type DatabaseCall = { kind: "first" | "all" | "run" | "batch"; sql: string[] };

function trackDatabase(database: D1Database) {
  const calls: DatabaseCall[] = [];
  const sqlByStatement = new WeakMap<D1PreparedStatement, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") {
          return (...values: Parameters<D1PreparedStatement["bind"]>) =>
            wrap(target.bind(...values), sql);
        }
        if (key === "first" || key === "all" || key === "run") {
          return (...args: unknown[]) => {
            calls.push({ kind: key, sql: [sql] });
            return Reflect.apply(Reflect.get(target, key), target, args);
          };
        }
        return Reflect.get(target, key, target);
      },
    });
    sqlByStatement.set(proxy, sql);
    return proxy;
  };
  const db = new Proxy(database, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch") {
        return (statements: D1PreparedStatement[]) => {
          calls.push({
            kind: "batch",
            sql: statements.map((statement) => {
              const sql = sqlByStatement.get(statement);
              if (sql === undefined) throw new Error("untracked_test_statement");
              return sql;
            }),
          });
          return target.batch(statements);
        };
      }
      return Reflect.get(target, key, target);
    },
  });
  return { db, calls };
}

function trackedEnv() {
  const stats = trackDatabase(env.STATS_DB);
  const observer = trackDatabase(env.OBSERVER_DB);
  const guard = trackDatabase(env.GUARD_DB);
  const calls = () => [...stats.calls, ...observer.calls, ...guard.calls];
  return {
    env: {
      ...observerEnv(),
      STATS_DB: stats.db,
      OBSERVER_DB: observer.db,
      GUARD_DB: guard.db,
    },
    stats,
    observer,
    guard,
    calls,
    statements: () => calls().reduce((count, call) => count + call.sql.length, 0),
  };
}

async function applySql(db: D1Database, sql: string) {
  for (const statement of sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)) {
    await db.prepare(statement).run();
  }
}

async function seedGuard(db: D1Database, nowMs: number, runtimeErrors = 0, exceededCpu = 0) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS usage_guard_state (
       singleton_id INTEGER PRIMARY KEY, action TEXT NOT NULL, observed_at TEXT NOT NULL,
       period_start TEXT NOT NULL, period_end TEXT NOT NULL, evidence_json TEXT NOT NULL,
       evidence_hash TEXT NOT NULL
     )`,
    )
    .run();
  const evidence = quotaEvidence(nowMs, runtimeErrors, exceededCpu);
  const json = JSON.stringify(evidence);
  const hash = await sha256(json);
  await db
    .prepare(
      `INSERT INTO usage_guard_state
      (singleton_id, action, observed_at, period_start, period_end, evidence_json, evidence_hash)
     VALUES (1, 'normal', ?, ?, ?, ?, ?)
     ON CONFLICT(singleton_id) DO UPDATE SET
       action=excluded.action, observed_at=excluded.observed_at,
       period_start=excluded.period_start, period_end=excluded.period_end,
       evidence_json=excluded.evidence_json, evidence_hash=excluded.evidence_hash`,
    )
    .bind(evidence.observedAt, evidence.plan.periodStart, evidence.plan.periodEnd, json, hash)
    .run();
}

function quotaEvidence(nowMs: number, runtimeErrors = 0, exceededCpu = 0): D1QuotaEvidence {
  const databases = Object.values(D1_DATABASE_IDS).map((databaseId, index) => ({
    databaseId,
    databaseName: `database-${index}`,
    rowsReadObserved: 0,
    rowsWrittenObserved: 0,
    storageBytesObserved: 0,
  }));
  const workers: D1QuotaEvidence["workers"] = [
    {
      scriptName: "collection-kit-stats-staging",
      requestsObserved: 1,
      cpuMsObserved: 1,
      errorsObserved: runtimeErrors,
      exceededCpuObserved: exceededCpu,
      cpuTimeAverageMs: 1,
      cpuTimeP95Ms: 1,
      cpuTimeP99Ms: 1,
    },
  ];
  const usage = {
    workerRequests: 1,
    workerCpuMs: 1,
    d1RowsRead: 0,
    d1RowsWritten: 0,
    d1StorageBytes: 0,
  };
  const metrics = buildMetricEvidence(usage, usage);
  const governing = [...metrics].sort(
    (left, right) =>
      Math.max(right.currentPercent, right.projectedPercent) -
        Math.max(left.currentPercent, left.projectedPercent) ||
      left.metric.localeCompare(right.metric),
  )[0];
  if (!governing) throw new Error("missing_test_governing_metric");
  return {
    version: 2,
    source: "cloudflare-paid-account-analytics-v2",
    observedAt: new Date(nowMs).toISOString(),
    plan: {
      id: "workers-paid",
      verified: true,
      state: "Paid",
      frequency: "monthly",
      periodStart: new Date(nowMs - 24 * 60 * 60_000).toISOString(),
      periodEnd: new Date(nowMs + 29 * 24 * 60 * 60_000).toISOString(),
    },
    limits: CLOUDFLARE_PAID_INCLUDED_LIMITS,
    thresholds: CLOUDFLARE_PAID_THRESHOLDS,
    usage,
    projectedUsage: usage,
    metrics,
    utilization: {
      currentPercent: Math.max(...metrics.map((metric) => metric.currentPercent)),
      projectedPercent: Math.max(...metrics.map((metric) => metric.projectedPercent)),
      governingMetric: governing.metric,
    },
    action: "normal",
    databases,
    workers,
    workerRuntime: {
      startedAt: new Date(
        nowMs - CLOUDFLARE_PAID_THRESHOLDS.canaryHours * 60 * 60_000,
      ).toISOString(),
      endedAt: new Date(nowMs).toISOString(),
      workers,
    },
    passed: true,
  };
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
