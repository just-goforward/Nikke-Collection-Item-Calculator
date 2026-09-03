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
});
