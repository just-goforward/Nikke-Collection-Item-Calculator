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
      error_code: "observer_invalid_count",
    });
    const cursor = await env.OBSERVER_DB.prepare(
      "SELECT last_events FROM observer_source_cursors WHERE source_kind='solver_failure'",
    ).first<{ last_events: number }>();
    expect(cursor?.last_events).toBe(0);
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
  await env.STATS_DB.prepare(
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
  )
    .bind("a".repeat(40), "b".repeat(40), events, now, now)
    .run();
}

async function applySql(db: D1Database, sql: string) {
  for (const statement of sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)) {
    await db.prepare(statement).run();
  }
}

async function seedGuard(db: D1Database, nowMs: number, runtimeErrors = 0) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS usage_guard_state (
       singleton_id INTEGER PRIMARY KEY, action TEXT NOT NULL, observed_at TEXT NOT NULL,
       period_start TEXT NOT NULL, period_end TEXT NOT NULL, evidence_json TEXT NOT NULL,
       evidence_hash TEXT NOT NULL
     )`,
    )
    .run();
  const evidence = quotaEvidence(nowMs, runtimeErrors);
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

function quotaEvidence(nowMs: number, runtimeErrors = 0): D1QuotaEvidence {
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
      exceededCpuObserved: 0,
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
