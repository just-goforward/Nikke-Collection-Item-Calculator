import { afterEach, describe, expect, it, vi } from "vitest";

import { makeStatsSubmissionEnvelope, readStatsError } from "./statsSubmitClient";

describe("makeStatsSubmissionEnvelope", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("attaches the referrer host only to confirmed result events", () => {
    vi.stubGlobal("window", {
      crypto: {
        getRandomValues(values: Uint32Array) {
          values.set([1, 2]);
          return values;
        },
      },
      location: { host: "nikkecollection.com" },
    });
    vi.stubGlobal("document", { referrer: "https://search.example/results" });

    const resultEnvelope = makeStatsSubmissionEnvelope({ kind: "kit_result" });
    const diagnosticEnvelope = makeStatsSubmissionEnvelope({ kind: "solver_diagnostic" });

    expect(resultEnvelope).toMatchObject({ sourceHost: "search.example" });
    expect(diagnosticEnvelope).not.toHaveProperty("sourceHost");
    expect(resultEnvelope).not.toHaveProperty("clientTime");
    expect(diagnosticEnvelope).not.toHaveProperty("clientTime");
  });
});

describe("statistics transport credentials", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("./statsRuntime");
    vi.resetModules();
  });

  it("never sends cookies or other credentials with event submissions", async () => {
    vi.resetModules();
    vi.doMock("./statsRuntime", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./statsRuntime")>()),
      statsSubmissionConfig: () => ({
        endpoint: "https://stats.example",
        turnstileSiteKey: "site-key",
      }),
    }));
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { submitStatsEnvelope } = await import("./statsSubmitClient");
    const provider = { issueToken: vi.fn(async () => "token"), reset: vi.fn() };

    await submitStatsEnvelope(
      { eventId: "event-1", event: { kind: "solver_diagnostic" } } as never,
      provider as never,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit" });
  });
});

describe("statistics response retry policy", () => {
  it("retries 429 responses even when the response body omits retryable", async () => {
    const error = await readStatsError(
      Response.json({ error: "rate_limited", retryable: false }, { status: 429 }),
    );

    expect(error).toMatchObject({
      retryable: true,
      failureClass: "rate_limited",
    });
  });

  it("does not retry explicit telemetry budget shutdowns", async () => {
    const error = await readStatsError(
      Response.json({ error: "telemetry_budget_disabled", retryable: true }, { status: 503 }),
    );

    expect(error).toMatchObject({
      retryable: false,
      failureClass: "quota_disabled",
    });
  });

  it("does not consume an oversized error response", async () => {
    const error = await readStatsError(
      new Response(JSON.stringify({ error: "x".repeat(20_000), retryable: true }), {
        status: 400,
        statusText: "Bad Request",
      }),
    );

    expect(error).toMatchObject({
      message: "Bad Request",
      retryable: false,
      failureClass: "contract_rejected",
    });
  });
});
