import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kitResultEvent, solverDiagnosticEvent, TEST_TURNSTILE_TOKEN } from "./worker.test-events";
import { WorkerTestHarness } from "./worker.test-harness";

const harness = new WorkerTestHarness();
const testEnv = harness.env;
const submit = (payload: object) => harness.submit(payload);
const fetchStats = (origin: string | null = "https://test.example") => harness.fetchStats(origin);
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
  });

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

describe("stats response compatibility", () => {
  it("keeps unused legacy fields as empty arrays", async () => {
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
    expect(body.levelKitStats).toEqual([]);
    expect(body.successAttemptDistribution).toEqual([]);
    expect(body.summary).toBeDefined();
    expect(body.byKit).toBeDefined();
    expect(body.cumulative).toBeDefined();
    expect(body.segmentStats).toBeDefined();
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

  it("answers preflight only for an allowed browser origin", async () => {
    const allowed = await preflight("https://test.example");
    const rejected = await preflight("https://not-allowed.example");

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://test.example");
    expect(rejected.status).toBe(403);
  });
});

describe("solver_diagnostic event commit", () => {
  it("writes one id and one diagnostic aggregate for a valid diagnostic", async () => {
    const response = await submit(solverDiagnosticEvent("solver-diag-valid-001"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await expect(countRows("event_ids")).resolves.toBe(1);
    await expect(countRows("solver_diagnostic_aggregates")).resolves.toBe(1);
    await expect(countRows("solver_node_count_aggregates")).resolves.toBe(1);
    await expect(countRows("solver_runtime_aggregates")).resolves.toBe(1);
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
    await expect(countRows("solver_node_count_aggregates")).resolves.toBe(1);
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
    await expect(countRows("solver_node_count_aggregates")).resolves.toBe(0);
    await expect(countRows("solver_runtime_aggregates")).resolves.toBe(0);
    await harness.database.exec("DROP TRIGGER fail_solver_diagnostic;");

    const retried = await submit(payload);

    expect(await retried.json()).toEqual({ ok: true });
    await expect(countRows("event_ids")).resolves.toBe(1);
    await expect(countRows("solver_diagnostic_aggregates")).resolves.toBe(1);
    await expect(countRows("solver_node_count_aggregates")).resolves.toBe(1);
    await expect(countRows("solver_runtime_aggregates")).resolves.toBe(1);
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

  it("returns private solver diagnostic aggregates by solver version and phase", async () => {
    const phase1 = solverDiagnosticEvent("solver-admin-phase1-01");
    const minEf1 = solverDiagnosticEvent("solver-admin-minef-001");
    const minEf2 = solverDiagnosticEvent("solver-admin-minef-002");
    minEf1.event.solverVersion = "phase3_rust_min_ef";
    minEf1.event.solverPhase = "phase3";
    minEf1.event.solverBackend = "rust-min-ef";
    minEf2.event.solverVersion = "phase3_rust_min_ef";
    minEf2.event.solverPhase = "phase3";
    minEf2.event.solverBackend = "rust-min-ef";

    expect((await submit(phase1)).status).toBe(200);
    expect((await submit(minEf1)).status).toBe(200);
    expect((await submit(minEf2)).status).toBe(200);

    const response = await fetchAdminSolverDiagnostics();
    const body = (await response.json()) as {
      windowDays?: number;
      since?: string;
      allTime?: Array<{
        solverVersion: string;
        solverPhase: string;
        events: number;
        firstDate: string | null;
        lastDate: string | null;
      }>;
      window?: Array<{ solverVersion: string; solverPhase: string; events: number }>;
      daily?: Array<{ date: string; solverVersion: string; solverPhase: string; events: number }>;
      nodeCounts?: Array<{
        solverVersion: string;
        solverPhase: string;
        nodeCountBucket: string;
        events: number;
      }>;
      runtime?: Array<{
        solverVersion: string;
        solverPhase: string;
        solverBackend: string;
        fallbackFrom: string;
        fallbackReason: string;
        grade: string;
        level: number;
        expBucket: number;
        stockBuckets: { blue: string; purple: string; yellow: string };
        nodeCountBucket: string;
        solveMsBucket: string;
        events: number;
      }>;
      fallbacks?: Array<{
        solverVersion: string;
        solverPhase: string;
        solverBackend: string;
        events: number;
        fallbackEvents: number;
        fallbackRate: number;
      }>;
      latencies?: Array<{
        solverVersion: string;
        solverPhase: string;
        solverBackend: string;
        solveMsBucket: string;
        events: number;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.windowDays).toBe(30);
    expect(body.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.allTime).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
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
          solverVersion: "phase3_rust_min_ef",
          solverPhase: "phase3",
          nodeCountBucket: "1000_9999",
          events: 2,
        }),
      ]),
    );
    expect(body.runtime).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          solverVersion: "phase3_rust_min_ef",
          solverPhase: "phase3",
          solverBackend: "rust-min-ef",
          fallbackFrom: "none",
          fallbackReason: "none",
          grade: "SR",
          level: 1,
          expBucket: 0,
          stockBuckets: { blue: "100_299", purple: "50_99", yellow: "10_49" },
          nodeCountBucket: "1000_9999",
          solveMsBucket: "0_50",
          events: 2,
        }),
      ]),
    );
    expect(body.fallbacks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          solverVersion: "phase3_rust_min_ef",
          solverBackend: "rust-min-ef",
          fallbackEvents: 0,
          fallbackRate: 0,
        }),
      ]),
    );
    expect(body.latencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          solverVersion: "phase3_rust_min_ef",
          solverBackend: "rust-min-ef",
          solveMsBucket: "0_50",
          events: 2,
        }),
      ]),
    );
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
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockSiteverify(
      { body: { success: false, "error-codes": ["internal-error"] } },
      { body: { success: true, action: "solver_diagnostic" } },
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
    expect(warning).toHaveBeenCalledWith(
      "Turnstile action mismatch observed.",
      expect.objectContaining({
        eventKind: "kit_result",
        expectedAction: "kit_result",
        returnedAction: "solver_diagnostic",
      }),
    );
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
    expect(warning).toHaveBeenCalledWith(
      "Turnstile verification unavailable.",
      expect.objectContaining({
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
    expect(warning).toHaveBeenCalledWith(
      "Turnstile verification unavailable.",
      expect.objectContaining({
        failure: "http_status",
        httpStatus: 503,
        internallyRetried: true,
      }),
    );
  });
});
