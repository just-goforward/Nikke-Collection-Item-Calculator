import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "./worker";

const TURNSTILE_TOKEN = "valid-turnstile-token-for-tests";
const REQUEST_URL = "https://worker.test/api/events";
let miniflare: Miniflare;
let database: D1Database;
let siteverifyForms: URLSearchParams[];
let siteverifyContentTypes: Array<string | null>;

const testEnv: {
  DB: D1Database;
  ALLOWED_ORIGINS: string;
  TURNSTILE_SECRET_KEY: string;
  RATE_LIMIT_SECRET?: string;
} = {
  DB: undefined as unknown as D1Database,
  ALLOWED_ORIGINS: "https://test.example",
  TURNSTILE_SECRET_KEY: "test-turnstile-secret",
  RATE_LIMIT_SECRET: "test-rate-limit-secret",
};

function kitResultEvent(eventId: string) {
  return {
    version: 1,
    eventId,
    sourceHost: "test.example",
    turnstileToken: TURNSTILE_TOKEN,
    event: {
      kind: "kit_result",
      start: { grade: "R", level: 0, exp: 0 },
      kit: "blue",
      recommendedUses: 1,
      strategy: "supply",
      outcome: "no_great_success",
      successAttempt: null,
      stockBefore: { blue: 10, purple: 0, yellow: 0 },
      stockAfter: { blue: 0, purple: 0, yellow: 0 },
      resultState: { grade: "R", level: 0, exp: 200 },
    },
  };
}

function solverDiagnosticEvent(eventId: string) {
  return {
    version: 1,
    eventId,
    sourceHost: "test.example",
    turnstileToken: TURNSTILE_TOKEN,
    event: {
      kind: "solver_diagnostic",
      diagnosticVersion: 1,
      solverVersion: "phase1",
      solverPhase: "phase1",
      start: { grade: "SR", level: 1, exp: 0 },
      strategy: "supply",
      stockBuckets: { blue: "100_299", purple: "50_99", yellow: "10_49" },
      recommendedKit: "blue",
      recommendedUsesBucket: "5_9",
      candidateCountBucket: "3_plus",
      probabilityGapBucket: "0_1_0_3pp",
      resourceCostBucket: "0_1_0_25",
      legacySupplyCostBucket: "0_1_0_25",
      totalExpectedCostBucket: "100_199",
      blueShareBucket: "50_70",
      minAutonomyDaysBucket: "14_28",
      changedFromSingle: "yes",
      changedFromLegacySupply: "no",
      legacyPrivateStatsAvailable: true,
      legacyEventAggregateMatchable: false,
    },
  };
}

async function submit(payload: object) {
  if (!worker.fetch) throw new Error("Worker fetch handler is not defined.");
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const request = new Request(REQUEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://test.example",
      "CF-Connecting-IP": "203.0.113.1",
    },
    body: JSON.stringify(payload),
  }) as unknown as Parameters<NonNullable<typeof worker.fetch>>[0];
  const response = await worker.fetch(request, testEnv, ctx);
  await Promise.allSettled(pending);
  return response;
}

async function fetchStats(origin: string | null = "https://test.example") {
  if (!worker.fetch) throw new Error("Worker fetch handler is not defined.");
  return worker.fetch(
    new Request("https://worker.test/api/stats", {
      headers: origin ? { Origin: origin } : undefined,
    }) as unknown as Parameters<NonNullable<typeof worker.fetch>>[0],
    testEnv,
    {} as ExecutionContext,
  );
}

async function preflight(origin: string) {
  if (!worker.fetch) throw new Error("Worker fetch handler is not defined.");
  return worker.fetch(
    new Request(REQUEST_URL, {
      method: "OPTIONS",
      headers: { Origin: origin },
    }) as unknown as Parameters<NonNullable<typeof worker.fetch>>[0],
    testEnv,
    {} as ExecutionContext,
  );
}

async function countRows(table: string) {
  const result = await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number;
  }>();
  return Number(result?.count || 0);
}

async function applySchema() {
  const statements = schemaSql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    await database.prepare(statement).run();
  }
}

function mockSiteverify(...outcomes: Array<{ body?: object; status?: number } | Error>): void {
  let index = 0;
  siteverifyForms = [];
  siteverifyContentTypes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      if (body instanceof URLSearchParams) siteverifyForms.push(body);
      siteverifyContentTypes.push(new Headers(init?.headers).get("Content-Type"));
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      if (outcome instanceof Error) throw outcome;
      return new Response(JSON.stringify(outcome?.body || { success: true }), {
        status: outcome?.status || 200,
      });
    }),
  );
}

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('unused'); } };",
    compatibilityDate: "2026-05-05",
    d1Databases: ["DB"],
  });
  database = (await miniflare.getD1Database("DB")) as unknown as D1Database;
  testEnv.DB = database;
  testEnv.RATE_LIMIT_SECRET = "test-rate-limit-secret";
  await applySchema();
  mockSiteverify({ body: { success: true } });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await miniflare.dispose();
});

describe("kit_result event commit", () => {
  it("fails closed without a rate-limit secret before writing counters or events", async () => {
    testEnv.RATE_LIMIT_SECRET = undefined;

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

  it("does not increment aggregates when an event id is submitted twice", async () => {
    const payload = kitResultEvent("kit-result-duplicate-001");

    expect((await submit(payload)).status).toBe(200);
    const duplicate = await submit(payload);

    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true });
    const aggregate = await database
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
    await database.exec(
      "CREATE TRIGGER fail_event_aggregate BEFORE INSERT ON event_aggregates BEGIN SELECT RAISE(ABORT, 'forced kit failure'); END;",
    );

    const failed = await submit(payload);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "storage_unavailable", retryable: true });
    await expect(countRows("event_ids")).resolves.toBe(0);
    await expect(countRows("event_aggregates")).resolves.toBe(0);
    await database.exec("DROP TRIGGER fail_event_aggregate;");

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
    const aggregate = await database
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
    const aggregate = await database
      .prepare("SELECT events FROM solver_diagnostic_aggregates LIMIT 1")
      .first<{ events: number }>();
    expect(aggregate).toMatchObject({ events: 1 });
    await expect(countRows("event_ids")).resolves.toBe(1);
  });

  it("rolls back the event id when a diagnostic write fails and accepts a retry", async () => {
    const payload = solverDiagnosticEvent("solver-diag-retry-0001");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await database.exec(
      "CREATE TRIGGER fail_solver_diagnostic BEFORE INSERT ON solver_diagnostic_aggregates BEGIN SELECT RAISE(ABORT, 'forced diagnostic failure'); END;",
    );

    const failed = await submit(payload);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "storage_unavailable", retryable: true });
    await expect(countRows("event_ids")).resolves.toBe(0);
    await expect(countRows("solver_diagnostic_aggregates")).resolves.toBe(0);
    await database.exec("DROP TRIGGER fail_solver_diagnostic;");

    const retried = await submit(payload);

    expect(await retried.json()).toEqual({ ok: true });
    await expect(countRows("event_ids")).resolves.toBe(1);
    await expect(countRows("solver_diagnostic_aggregates")).resolves.toBe(1);
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
    expect(siteverifyForms).toHaveLength(2);
    expect(siteverifyForms[0].get("response")).toBe(TURNSTILE_TOKEN);
    expect(siteverifyForms[1].get("response")).toBe(TURNSTILE_TOKEN);
    expect(siteverifyForms[1].get("idempotency_key")).toBe(
      siteverifyForms[0].get("idempotency_key"),
    );
    expect(siteverifyContentTypes).toEqual([
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
    expect(siteverifyForms).toHaveLength(2);
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
    expect(siteverifyForms).toHaveLength(2);
    expect(siteverifyForms[1].get("idempotency_key")).toBe(
      siteverifyForms[0].get("idempotency_key"),
    );
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
