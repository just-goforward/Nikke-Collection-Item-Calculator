import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupExpiredStatistics } from "./rate-limit";
import {
  kitResultEvent,
  solverDiagnosticEvent,
  solverRecoveryEvent,
  TEST_TURNSTILE_TOKEN,
} from "./worker.test-events";
import { WorkerTestHarness } from "./worker.test-harness";
import type { AdminDiagnosticsBody } from "./worker.test-types";

const harness = new WorkerTestHarness();
const testEnv = harness.env;
const submit = (payload: object) => harness.submit(payload);
const fetchStats = (origin: string | null = "https://test.example", headers?: HeadersInit) =>
  harness.fetchStats(origin, headers);
const fetchHealth = (origin: string | null = "https://test.example") => harness.fetchHealth(origin);
const fetchAdminSolverDiagnostics = (
  token: string | null = "test-admin-token",
  origin: string | null = "https://test.example",
) => harness.fetchAdminSolverDiagnostics(token, origin);
const preflight = (origin: string) => harness.preflight(origin);
const countRows = (table: string) => harness.countRows(table);
const mockSiteverify = (...outcomes: Parameters<WorkerTestHarness["mockSiteverify"]>) =>
  harness.mockSiteverify(...outcomes);
const siteverifyForm = (index: number) => harness.siteverifyForm(index);

beforeEach(async () => {
  await harness.setup();
});

afterEach(async () => {
  await harness.teardown();
});

describe("kit_result event commit", () => {
  it("fails closed without a rate-limit secret before writing counters or events", async () => {
    delete testEnv.RATE_LIMIT_SECRET;

    const response = await submit(kitResultEvent("missing-rate-secret01"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "rate_limit_not_configured" });
    await expect(countRows("rate_limits")).resolves.toBe(0);
    await expect(countRows("event_ids")).resolves.toBe(0);
    await expect(countRows("event_aggregates")).resolves.toBe(0);
  });

  it("writes one id and all public/private aggregates for a valid result", async () => {
    const response = await submit(kitResultEvent("kit-result-valid-0001"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await expect(countRows("event_ids")).resolves.toBe(1);
    await expect(countRows("event_aggregates")).resolves.toBe(1);
    await expect(countRows("referrer_aggregates")).resolves.toBe(1);
    await expect(countRows("client_env_aggregates")).resolves.toBe(1);
  });

  it("rate-limits repeated accepted submissions before writing the limited event", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      for (let index = 0; index < 30; index += 1) {
        const response = await submit(
          kitResultEvent(`kit-result-rate-${String(index).padStart(4, "0")}`),
        );
        expect(response.status).toBe(200);
      }

      const limited = await submit(kitResultEvent("kit-result-rate-limited"));

      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: "rate_limited" });
      await expect(countRows("event_ids")).resolves.toBe(30);
    } finally {
      nowSpy.mockRestore();
    }
  }, 30_000);

  it("does not increment aggregates when an event id is submitted twice", async () => {
    const payload = kitResultEvent("kit-result-duplicate-001");

    expect((await submit(payload)).status).toBe(200);
    const duplicate = await submit(payload);

    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true });
    const aggregate = await harness.database
      .prepare("SELECT events, attempts FROM event_aggregates LIMIT 1")
      .first<{ events: number; attempts: number }>();
    expect(aggregate).toMatchObject({ events: 1, attempts: 1 });
    await expect(countRows("event_ids")).resolves.toBe(1);
    await expect(countRows("referrer_aggregates")).resolves.toBe(1);
    await expect(countRows("client_env_aggregates")).resolves.toBe(1);
  });

  it("rolls back the event id when an aggregate write fails and accepts a retry", async () => {
    const payload = kitResultEvent("kit-result-retry-000001");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await harness.database.exec(
      "CREATE TRIGGER fail_event_aggregate BEFORE INSERT ON event_aggregates BEGIN SELECT RAISE(ABORT, 'forced kit failure'); END;",
    );

    const failed = await submit(payload);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "storage_unavailable", retryable: true });
    await expect(countRows("event_ids")).resolves.toBe(0);
    await expect(countRows("event_aggregates")).resolves.toBe(0);
    await harness.database.exec("DROP TRIGGER fail_event_aggregate;");

    const retried = await submit(payload);

    expect(await retried.json()).toEqual({ ok: true });
    await expect(countRows("event_ids")).resolves.toBe(1);
    await expect(countRows("event_aggregates")).resolves.toBe(1);
  });
});

describe("D1 schema health", () => {
  it("reports the current aggregate schema contract", async () => {
    const response = await fetchHealth();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, schemaContractVersion: 3 });
  });

  it("fails closed when a required aggregate table is unavailable", async () => {
    await harness.database.exec("DROP TABLE runtime_invariant_aggregates;");

    const response = await fetchHealth();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "database_schema_not_ready",
      retryable: true,
    });
  });
});

describe("stats response compatibility", () => {
  it("keeps legacy fields present for stats consumers", async () => {
    const response = await fetchStats();
    const body = (await response.json()) as {
      levelKitStats?: unknown[];
      successAttemptDistribution?: unknown[];
      summary?: unknown;
      byKit?: unknown;
      cumulative?: unknown;
      segmentStats?: unknown;
    };

    expect(response.status).toBe(200);
    expect(body.levelKitStats).toHaveLength(30);
    expect(body.successAttemptDistribution).toEqual([]);
    expect(body.summary).toBeDefined();
    expect(body.byKit).toBeDefined();
    expect(body.cumulative).toBeDefined();
    expect(body.segmentStats).toBeDefined();
  });

  it("uses all historical aggregate rows for public statistics by default", async () => {
    await harness.database
      .prepare(
        `INSERT INTO event_aggregates
         (date_key, grade, level, exp_bucket, kit, recommended_uses, outcome, success_attempt, events, attempts, great_successes, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("2020-01-01", "R", 0, 50, "blue", 1, "great", 1, 1, 3, 2, 1_800_000_000)
      .run();

    const response = await fetchStats();
    const body = (await response.json()) as {
      windowDays?: number;
      summary?: { events?: number; attempts?: number; greatSuccesses?: number };
      byKit?: Array<{ kit?: string; attempts?: number }>;
      levelKitStats?: Array<{
        grade?: string;
        level?: number;
        kits?: {
          blue?: { attempts?: number; pieces?: number };
          purple?: { attempts?: number; pieces?: number };
          yellow?: { attempts?: number; pieces?: number };
        };
      }>;
      segmentStats?: Array<{
        key?: string;
        attempts?: number;
        pieces?: number;
        byKit?: Array<{ kit?: string; attempts?: number; pieces?: number }>;
      }>;
      cumulative?: { summary?: { events?: number; attempts?: number; greatSuccesses?: number } };
    };

    expect(response.status).toBe(200);
    expect(body.windowDays).toBe(0);
    expect(body.summary).toMatchObject({ events: 1, attempts: 3, greatSuccesses: 2 });
    expect(body.cumulative?.summary).toMatchObject({ events: 1, attempts: 3, greatSuccesses: 2 });
    expect(body.byKit?.find((item) => item.kit === "blue")).toMatchObject({ attempts: 3 });
    expect(
      body.levelKitStats?.find((item) => item.grade === "R" && item.level === 0)?.kits?.blue,
    ).toMatchObject({ attempts: 3, pieces: 30 });
    expect(body.segmentStats?.find((item) => item.key === "R:0")).toMatchObject({
      attempts: 3,
      pieces: 30,
      byKit: expect.arrayContaining([expect.objectContaining({ kit: "blue", pieces: 30 })]),
    });
  });

  it("keeps the existing origin policy for browser and non-browser reads", async () => {
    const allowed = await fetchStats();
    const noOrigin = await fetchStats(null);
    const rejected = await fetchStats("https://not-allowed.example");

    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://test.example");
    expect(noOrigin.status).toBe(200);
    expect(noOrigin.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(rejected.status).toBe(403);
  });

  it("returns an ETag and answers matching stats requests with 304", async () => {
    const first = await fetchStats();
    const etag = first.headers.get("ETag");

    expect(first.status).toBe(200);
    expect(etag).toMatch(/^W\/"stats-/);

    const second = await fetchStats("https://test.example", { "If-None-Match": etag || "" });

    expect(second.status).toBe(304);
    expect(second.headers.get("ETag")).toBe(etag);
    expect(second.headers.get("Access-Control-Allow-Origin")).toBe("https://test.example");
    expect(await second.text()).toBe("");
  });

  it("answers preflight only for an allowed browser origin", async () => {
    const allowed = await preflight("https://test.example");
    const rejected = await preflight("https://not-allowed.example");

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://test.example");
    expect(rejected.status).toBe(403);
  });
});

describe("scheduled statistics cleanup", () => {
  it("deletes only expired rate-limit and event-id rows", async () => {
    const now = 1_800_000_000;
    await harness.database.batch([
      harness.database
        .prepare("INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)")
        .bind("expired", now - 1),
      harness.database
        .prepare("INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)")
        .bind("active", now + 1),
      harness.database
        .prepare("INSERT INTO event_ids (id, created_at) VALUES (?, ?)")
        .bind("expired-event-id", now - 86400 * 15),
      harness.database
        .prepare("INSERT INTO event_ids (id, created_at) VALUES (?, ?)")
        .bind("active-event-id", now - 86400 * 13),
    ]);

    const database = testEnv.DB;
    if (!database) throw new Error("Test database was not initialized.");
    await cleanupExpiredStatistics({ DB: database }, now);

    await expect(countRows("rate_limits")).resolves.toBe(1);
    await expect(countRows("event_ids")).resolves.toBe(1);
  });
});

describe("solver_diagnostic event commit", () => {
  it("writes one id and one diagnostic aggregate for a valid diagnostic", async () => {
    const response = await submit(solverDiagnosticEvent("solver-diag-valid-001"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await expect(countRows("event_ids")).resolves.toBe(1);
    await expect(countRows("solver_diagnostic_aggregates")).resolves.toBe(1);
    await expect(countRows("solver_runtime_aggregates")).resolves.toBe(1);
    await expect(countRows("solver_cache_aggregates")).resolves.toBe(1);
    const runtime = await harness.database
      .prepare(
        `SELECT forecast_id, memory_strategy, min_ef_memo_tier, phase2_memo_tier, phase2_memo_retried
         FROM solver_runtime_aggregates
         LIMIT 1`,
      )
      .first<{
        forecast_id: string;
        memory_strategy: string;
        min_ef_memo_tier: string;
        phase2_memo_tier: string;
        phase2_memo_retried: string;
      }>();
    expect(runtime).toMatchObject({
      forecast_id: "supply-2026-08-21-v1",
      memory_strategy: "balanced-v1",
      min_ef_memo_tier: "21",
      phase2_memo_tier: "22",
      phase2_memo_retried: "no",
    });
  });

  it("keeps cache hits in usage and cache aggregates without duplicating runtime", async () => {
    const executed = solverDiagnosticEvent("solver-cache-executed1");
    const cacheHit = solverDiagnosticEvent("solver-cache-hit-0001");
    cacheHit.event.executionKind = "cache_hit";

    expect((await submit(executed)).status).toBe(200);
    expect((await submit(cacheHit)).status).toBe(200);

    const usage = await harness.database
      .prepare("SELECT SUM(events) AS events FROM solver_diagnostic_aggregates")
      .first<{ events: number }>();
    const runtime = await harness.database
      .prepare("SELECT SUM(events) AS events FROM solver_runtime_aggregates")
      .first<{ events: number }>();
    const cache = await harness.database
      .prepare(
        "SELECT execution_kind, SUM(events) AS events FROM solver_cache_aggregates GROUP BY execution_kind ORDER BY execution_kind",
      )
      .all<{ execution_kind: string; events: number }>();

    expect(usage?.events).toBe(2);
    expect(runtime?.events).toBe(1);
    expect(cache.results).toEqual([
      { execution_kind: "cache_hit", events: 1 },
      { execution_kind: "executed", events: 1 },
    ]);
  });

  it("normalizes the requested backend fallback for legacy diagnostics", async () => {
    const payload = solverDiagnosticEvent("solver-diag-legacy-backend");
    payload.event.diagnosticVersion = 5;
    payload.event.solverBackend = "invalid backend value";
    Reflect.deleteProperty(payload.event, "requestedBackend");
    Reflect.deleteProperty(payload.event, "executionKind");

    expect((await submit(payload)).status).toBe(200);

    const cache = await harness.database
      .prepare(
        "SELECT requested_backend, terminal_backend, execution_kind FROM solver_cache_aggregates LIMIT 1",
      )
      .first<{
        requested_backend: string;
        terminal_backend: string;
        execution_kind: string;
      }>();
    expect(cache).toEqual({
      requested_backend: "unknown",
      terminal_backend: "unknown",
      execution_kind: "executed",
    });
  });

  it("accepts diagnostic v2 with 50-piece stock buckets", async () => {
    const payload = solverDiagnosticEvent("solver-diag-v2-bucket1");
    payload.event.diagnosticVersion = 2;
    payload.event.stockBuckets = {
      blue: "300_349",
      purple: "150_199",
      yellow: "50_99",
    };

    const response = await submit(payload);

    expect(response.status).toBe(200);
    const aggregate = await harness.database
      .prepare(
        `SELECT diagnostic_version, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow
         FROM solver_diagnostic_aggregates
         LIMIT 1`,
      )
      .first<{
        diagnostic_version: number;
        stock_bucket_blue: string;
        stock_bucket_purple: string;
        stock_bucket_yellow: string;
      }>();
    expect(aggregate).toMatchObject({
      diagnostic_version: 2,
      stock_bucket_blue: "300_349",
      stock_bucket_purple: "150_199",
      stock_bucket_yellow: "50_99",
    });
  });

  it("does not increment diagnostic aggregates when an event id is submitted twice", async () => {
    const payload = solverDiagnosticEvent("solver-diag-duplicate1");

    expect((await submit(payload)).status).toBe(200);
    const duplicate = await submit(payload);

    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true });
    const aggregate = await harness.database
      .prepare("SELECT events FROM solver_diagnostic_aggregates LIMIT 1")
      .first<{ events: number }>();
    expect(aggregate).toMatchObject({ events: 1 });
    await expect(countRows("event_ids")).resolves.toBe(1);
    await expect(countRows("solver_runtime_aggregates")).resolves.toBe(1);
  });

  it("rolls back the event id when a diagnostic write fails and accepts a retry", async () => {
    const payload = solverDiagnosticEvent("solver-diag-retry-0001");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await harness.database.exec(
      "CREATE TRIGGER fail_solver_diagnostic BEFORE INSERT ON solver_diagnostic_aggregates BEGIN SELECT RAISE(ABORT, 'forced diagnostic failure'); END;",
    );

    const failed = await submit(payload);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "storage_unavailable", retryable: true });
    await expect(countRows("event_ids")).resolves.toBe(0);
    await expect(countRows("solver_diagnostic_aggregates")).resolves.toBe(0);
    await expect(countRows("solver_runtime_aggregates")).resolves.toBe(0);
    await harness.database.exec("DROP TRIGGER fail_solver_diagnostic;");

    const retried = await submit(payload);

    expect(await retried.json()).toEqual({ ok: true });
    await expect(countRows("event_ids")).resolves.toBe(1);
    await expect(countRows("solver_diagnostic_aggregates")).resolves.toBe(1);
    await expect(countRows("solver_runtime_aggregates")).resolves.toBe(1);
  });
});

describe("solver_recovery event commit", () => {
  it("writes bucketed rung and terminal aggregates without raw attempt identifiers", async () => {
    const response = await submit(solverRecoveryEvent("solver-recovery-valid1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await expect(countRows("solver_recovery_rung_aggregates")).resolves.toBe(2);
    await expect(countRows("solver_recovery_terminal_aggregates")).resolves.toBe(1);
    const terminal = await harness.database
      .prepare(
        `SELECT forecast_id, policy_version, requested_backend, min_ef_exit, phase2_exit,
                terminal_backend, terminal_outcome, device_type
         FROM solver_recovery_terminal_aggregates`,
      )
      .first<{
        forecast_id: string;
        policy_version: string;
        requested_backend: string;
        min_ef_exit: string;
        phase2_exit: string;
        terminal_backend: string;
        terminal_outcome: string;
        device_type: string;
      }>();
    expect(terminal).toEqual({
      forecast_id: "supply-2026-08-21-v1",
      policy_version: "ladder_v1",
      requested_backend: "rust-min-ef",
      min_ef_exit: "memo_full",
      phase2_exit: "success",
      terminal_backend: "rust-phase2",
      terminal_outcome: "success",
      device_type: "unknown",
    });

    const admin = (await (await fetchAdminSolverDiagnostics()).json()) as AdminDiagnosticsBody;
    expect(admin.recoveryRungs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          forecastId: "supply-2026-08-21-v1",
          policyVersion: "ladder_v1",
          rungBackend: "rust-min-ef",
          rungExit: "memo_full",
          events: 1,
        }),
      ]),
    );
    expect(admin.recoveryTerminals).toEqual([
      expect.objectContaining({
        forecastId: "supply-2026-08-21-v1",
        policyVersion: "ladder_v1",
        terminalBackend: "rust-phase2",
        terminalOutcome: "success",
        events: 1,
      }),
    ]);
  });
});

describe("admin solver diagnostics", () => {
  it("fails closed when the admin token is not configured", async () => {
    delete testEnv.ADMIN_TOKEN;

    const response = await fetchAdminSolverDiagnostics();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("rejects missing, wrong, and disallowed-origin admin requests", async () => {
    const missing = await fetchAdminSolverDiagnostics(null);
    const wrong = await fetchAdminSolverDiagnostics("wrong-token");
    const disallowedOrigin = await fetchAdminSolverDiagnostics(
      "test-admin-token",
      "https://not-allowed.example",
    );

    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: "admin_forbidden" });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "admin_forbidden" });
    expect(disallowedOrigin.status).toBe(403);
    expect(await disallowedOrigin.json()).toEqual({ error: "origin_not_allowed" });
  });
});

describe("admin solver diagnostic aggregates", () => {
  it("returns private solver diagnostic aggregates by solver version and phase", async () => {
    const phase1 = solverDiagnosticEvent("solver-admin-phase1-01");
    const minEf1 = solverDiagnosticEvent("solver-admin-minef-001");
    const minEf2 = solverDiagnosticEvent("solver-admin-minef-002");
    const minEfFallback = solverDiagnosticEvent("solver-admin-fallback-01");
    minEf1.event.solverVersion = "phase3_rust_min_ef";
    minEf1.event.solverPhase = "phase3";
    minEf1.event.solverBackend = "rust-min-ef";
    minEf1.event.requestedBackend = "rust-min-ef";
    minEf2.event.solverVersion = "phase3_rust_min_ef";
    minEf2.event.solverPhase = "phase3";
    minEf2.event.solverBackend = "rust-min-ef";
    minEf2.event.requestedBackend = "rust-min-ef";
    minEfFallback.event.solverVersion = "phase2_availability_h075_tau0_p3_rust";
    minEfFallback.event.solverPhase = "phase2";
    minEfFallback.event.solverBackend = "rust-phase2";
    minEfFallback.event.requestedBackend = "rust-min-ef";
    minEfFallback.event.fallbackFrom = "rust-min-ef";
    minEfFallback.event.fallbackReason = "memo_full";
    minEfFallback.event.attemptedNodeCountBucket = "500000_999999";

    expect((await submit(phase1)).status).toBe(200);
    expect((await submit(minEf1)).status).toBe(200);
    expect((await submit(minEf2)).status).toBe(200);
    expect((await submit(minEfFallback)).status).toBe(200);

    const response = await fetchAdminSolverDiagnostics();
    const body = (await response.json()) as AdminDiagnosticsBody;

    expect(response.status).toBe(200);
    expect(body.windowDays).toBe(30);
    expect(body.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.allTime).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          forecastId: "supply-2026-08-21-v1",
          solverVersion: "phase3_rust_min_ef",
          solverPhase: "phase3",
          events: 2,
        }),
        expect.objectContaining({
          solverVersion: "phase1",
          solverPhase: "phase1",
          events: 1,
        }),
      ]),
    );
    expect(body.window).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          solverVersion: "phase3_rust_min_ef",
          solverPhase: "phase3",
          events: 2,
        }),
      ]),
    );
    expect(body.cache).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          diagnosticVersion: 7,
          forecastId: "supply-2026-08-21-v1",
          requestedBackend: "rust-min-ef",
          terminalBackend: "rust-min-ef",
          executionKind: "executed",
        }),
      ]),
    );
    expect(body.daily).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          solverVersion: "phase3_rust_min_ef",
          solverPhase: "phase3",
          events: 2,
        }),
      ]),
    );
    expect(body.nodeCounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          solverBackend: "rust-min-ef",
          nodeCountBucket: "1000_9999",
          events: 2,
        }),
      ]),
    );
    expect(body.runtime).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          forecastId: "supply-2026-08-21-v1",
          solverVersion: "phase3_rust_min_ef",
          solverPhase: "phase3",
          solverBackend: "rust-min-ef",
          fallbackFrom: "none",
          fallbackReason: "none",
          memoryStrategy: "balanced-v1",
          minEfMemoTier: "21",
          phase2MemoTier: "22",
          phase2MemoRetried: "no",
          grade: "SR",
          level: 1,
          expBucket: 0,
          stockBuckets: { blue: "100_299", purple: "50_99", yellow: "10_49" },
          nodeCountBucket: "1000_9999",
          attemptedNodeCountBucket: "1000_9999",
          solveMsBucket: "0_50",
          events: 2,
        }),
      ]),
    );
    expect(body.fallbacks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attemptedBackend: "rust-min-ef",
          events: 3,
          fallbackEvents: 1,
          fallbackRate: 1 / 3,
        }),
      ]),
    );
    expect(body.latencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          forecastId: "supply-2026-08-21-v1",
          solverVersion: "phase3_rust_min_ef",
          solverBackend: "rust-min-ef",
          solveMsBucket: "0_50",
          events: 2,
        }),
      ]),
    );
  });

  it("documents runtime trust and independent recovery aggregate semantics", async () => {
    const body = (await (await fetchAdminSolverDiagnostics()).json()) as AdminDiagnosticsBody;

    expect(body.runtimeDataPolicy).toEqual({
      trustworthyFromDiagnosticVersion: 6,
      filteredToTrustworthyVersions: true,
      legacyClassification: "usage_weighted_historical_snapshot",
      solveMsSemantics: "end_to_end_recovery_wall_time",
    });
    expect(body.recoveryDataPolicy).toEqual({
      aggregatesAreIndependent: true,
      ratioWarning: "do_not_divide_terminal_counts_by_rung_counts",
    });
  });

  it("keeps legacy diagnostics in history but excludes them from runtime distributions", async () => {
    const legacy = solverDiagnosticEvent("solver-admin-legacy-v5-01");
    legacy.event.diagnosticVersion = 5;
    legacy.event.solverVersion = "legacy_runtime_v5";
    legacy.event.solverPhase = "legacy";
    legacy.event.solverBackend = "legacy-js";
    legacy.event.requestedBackend = "legacy-js";
    const current = solverDiagnosticEvent("solver-admin-current-v6");

    expect((await submit(legacy)).status).toBe(200);
    expect((await submit(current)).status).toBe(200);

    const body = (await (await fetchAdminSolverDiagnostics()).json()) as AdminDiagnosticsBody;
    expect(body.allTime).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ solverVersion: "legacy_runtime_v5", events: 1 }),
      ]),
    );
    expect(body.runtime?.some((row) => row.solverVersion === "legacy_runtime_v5")).toBe(false);
    expect(body.nodeCounts?.some((row) => row.solverBackend === "legacy-js")).toBe(false);
    expect(body.cache?.some((row) => row.diagnosticVersion === 5)).toBe(false);
  });
});

describe("admin supply forecast registry", () => {
  it("resolves stored forecast IDs to their exact supply assumptions", async () => {
    const body = (await (await fetchAdminSolverDiagnostics()).json()) as AdminDiagnosticsBody;

    expect(body.supplyForecastRegistry).toEqual({
      version: 1,
      activeForecastId: "supply-2026-08-21-v1",
      forecasts: [
        {
          id: "supply-2026-08-21-v1",
          basisDays: 28,
          effectiveFrom: "2026-08-21",
          expectedGain: { blue: 473.912, purple: 55.808, yellow: 24.736 },
        },
      ],
    });
  });
});

describe("Turnstile verification response handling", () => {
  it("returns a retryable JSON error for duplicate or expired tokens", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockSiteverify({
      body: {
        success: false,
        "error-codes": ["timeout-or-duplicate"],
        action: "kit_result",
      },
    });

    const response = await submit(kitResultEvent("turnstile-duplicate01"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "turnstile_failed", retryable: true });
    await expect(countRows("event_ids")).resolves.toBe(0);
  });

  it("returns a retryable JSON error for an invalid response token", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockSiteverify({ body: { success: false, "error-codes": ["invalid-input-response"] } });

    const response = await submit(kitResultEvent("turnstile-invalid-001"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "turnstile_failed", retryable: true });
  });

  it("does not retry configuration errors on the client", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockSiteverify({
      status: 400,
      body: { success: false, "error-codes": ["invalid-input-secret"] },
    });

    const response = await submit(kitResultEvent("turnstile-secret-0001"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "turnstile_failed", retryable: false });
  });

  it("retries a transient Siteverify error with the same token and idempotency key", async () => {
    mockSiteverify(
      { body: { success: false, "error-codes": ["internal-error"] } },
      { body: { success: true, action: "kit_result" } },
    );

    const response = await submit(kitResultEvent("turnstile-internal-001"));

    expect(response.status).toBe(200);
    expect(harness.siteverifyForms).toHaveLength(2);
    expect(siteverifyForm(0).get("response")).toBe(TEST_TURNSTILE_TOKEN);
    expect(siteverifyForm(1).get("response")).toBe(TEST_TURNSTILE_TOKEN);
    expect(siteverifyForm(1).get("idempotency_key")).toBe(siteverifyForm(0).get("idempotency_key"));
    expect(harness.siteverifyContentTypes).toEqual([
      "application/x-www-form-urlencoded",
      "application/x-www-form-urlencoded",
    ]);
  });

  it("rejects a successful Turnstile response for a different action", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockSiteverify({ body: { success: true, action: "solver_diagnostic" } });

    const response = await submit(kitResultEvent("turnstile-action-0001"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "turnstile_action_mismatch",
      retryable: false,
    });
    await expect(countRows("event_ids")).resolves.toBe(0);
  });

  it("returns retryable unavailable responses for transient Siteverify transport failures", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockSiteverify(new Error("network down"), new Error("network still down"));

    const networkResponse = await submit(kitResultEvent("turnstile-network-0001"));

    expect(networkResponse.status).toBe(502);
    expect(await networkResponse.json()).toEqual({
      error: "turnstile_unavailable",
      retryable: true,
    });
    expect(harness.siteverifyForms).toHaveLength(2);
    const networkWarnings = warning.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(networkWarnings).toContainEqual(
      expect.objectContaining({
        event: "turnstile_verification_unavailable",
        failure: "fetch_error",
        httpStatus: null,
        internallyRetried: true,
      }),
    );

    mockSiteverify({ status: 503 }, { status: 503 });

    const nonOkResponse = await submit(kitResultEvent("turnstile-http-000001"));

    expect(nonOkResponse.status).toBe(502);
    expect(await nonOkResponse.json()).toEqual({
      error: "turnstile_unavailable",
      retryable: true,
    });
    expect(harness.siteverifyForms).toHaveLength(2);
    expect(siteverifyForm(1).get("idempotency_key")).toBe(siteverifyForm(0).get("idempotency_key"));
    const httpWarnings = warning.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(httpWarnings).toContainEqual(
      expect.objectContaining({
        event: "turnstile_verification_unavailable",
        failure: "http_status",
        httpStatus: 503,
        internallyRetried: true,
      }),
    );
  });
});
