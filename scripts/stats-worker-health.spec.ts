import { describe, expect, it, vi } from "vitest";

import {
  fetchExpectedHealthAfterDeployment,
  HealthTransportError,
  STATS_GATEWAY_ORIGIN,
  STATS_PROBE_PATH,
  statsProbeConfiguration,
} from "./stats-worker-health";

const configuration = statsProbeConfiguration(
  "https://collection-kit-stats-staging.tbvj159.workers.dev",
  "direct-staging",
);
const token = "a".repeat(43);
const gateway = statsProbeConfiguration(STATS_GATEWAY_ORIGIN, "gateway", token);
const payload = { ok: true, schemaContractVersion: 6 };
const options = {
  configuration: gateway,
  allowedOrigin: STATS_GATEWAY_ORIGIN,
  expectedContractVersion: 6,
  sleep: async () => undefined,
};

describe("fetchExpectedHealthAfterDeployment", () => {
  it("waits for an older deployed contract to stop serving", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, schemaContractVersion: 1 }, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({ ok: true, schemaContractVersion: 2 }, { status: 200 }),
      );
    const sleep = vi.fn(async () => undefined);

    const result = await fetchExpectedHealthAfterDeployment({
      allowedOrigin: "https://nikkecollection.com",
      attempts: 3,
      configuration,
      expectedContractVersion: 2,
      fetchImpl,
      sleep,
    });

    expect(result.payload).toEqual({ ok: true, schemaContractVersion: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("smokeAttempt=2");
  });

  it("waits for a deployment route 404 before accepting the current contract", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ ok: true, schemaContractVersion: 2 }, { status: 200 }),
      );
    const sleep = vi.fn(async () => undefined);

    const result = await fetchExpectedHealthAfterDeployment({
      allowedOrigin: "https://nikkecollection.com",
      attempts: 3,
      configuration,
      expectedContractVersion: 2,
      fetchImpl,
      sleep,
    });

    expect(result.response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("bounds the health response before parsing JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        schemaContractVersion: 2,
        padding: "x".repeat(2_048),
      }),
    );

    await expect(
      fetchExpectedHealthAfterDeployment({
        allowedOrigin: "https://nikkecollection.com",
        attempts: 3,
        configuration,
        expectedContractVersion: 2,
        fetchImpl,
        maxResponseBytes: 256,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("health_response_invalid");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries a timed out request with a fresh abort signal", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      if (signals.length === 1) throw new DOMException("timed out", "TimeoutError");
      return Response.json({ ok: true, schemaContractVersion: 2 }, { status: 200 });
    });
    const sleep = vi.fn(async () => undefined);

    const result = await fetchExpectedHealthAfterDeployment({
      allowedOrigin: "https://nikkecollection.com",
      attempts: 2,
      configuration,
      expectedContractVersion: 2,
      fetchImpl,
      requestTimeoutMs: 50,
      sleep,
    });

    expect(result.response.status).toBe(200);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("waits for a retryable schema propagation failure to clear", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: "database_schema_not_ready", retryable: true }, { status: 503 }),
      )
      .mockResolvedValueOnce(
        Response.json({ ok: true, schemaContractVersion: 2 }, { status: 200 }),
      );
    const sleep = vi.fn(async () => undefined);

    const result = await fetchExpectedHealthAfterDeployment({
      allowedOrigin: "https://nikkecollection.com",
      attempts: 3,
      configuration,
      expectedContractVersion: 2,
      fetchImpl,
      sleep,
    });

    expect(result.payload).toEqual({ ok: true, schemaContractVersion: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("fails after retryable schema propagation remains unavailable", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ error: "database_schema_not_ready", retryable: true }, { status: 503 }),
      );
    const sleep = vi.fn(async () => undefined);

    await expect(
      fetchExpectedHealthAfterDeployment({
        allowedOrigin: "https://nikkecollection.com",
        attempts: 3,
        configuration,
        expectedContractVersion: 2,
        fetchImpl,
        sleep,
      }),
    ).rejects.toThrow("deployment propagation retry exhausted");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("fails immediately for a non-retryable current contract failure", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: "database_schema_not_ready", retryable: false }, { status: 503 }),
      );
    const sleep = vi.fn(async () => undefined);

    await expect(
      fetchExpectedHealthAfterDeployment({
        allowedOrigin: "https://nikkecollection.com",
        attempts: 3,
        configuration,
        expectedContractVersion: 2,
        fetchImpl,
        sleep,
      }),
    ).rejects.toThrow("database_schema_not_ready");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledOnce();
  });
});

describe("private health transport", () => {
  it("sends credentials only to the exact fixed HTTPS URL, with redirects disabled", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    await fetchExpectedHealthAfterDeployment({ ...options, fetchImpl });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${STATS_GATEWAY_ORIGIN}${STATS_PROBE_PATH}`);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).has("Origin")).toBe(false);
  });

  it.each([
    "https://evil.example",
    `${STATS_GATEWAY_ORIGIN}/api/health`,
    `${STATS_GATEWAY_ORIGIN}?token=leak`,
    `${STATS_GATEWAY_ORIGIN}#fragment`,
    "https://user@nikkecollection.com",
    "http://nikkecollection.com",
    "https://nikkecollection.com:444",
  ])("rejects %s before any request", async (endpoint) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      fetchExpectedHealthAfterDeployment({
        ...options,
        configuration: { ...gateway, endpoint },
        fetchImpl,
      }),
    ).rejects.toThrow("endpoint/profile mismatch");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [429, {}, "rate limited"],
    [200, { "cf-mitigated": "challenge" }, "challenge"],
    [404, {}, "authentication/routing uncertainty"],
  ])("never accepts status %s as health success", async (status, headers, message) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("not JSON", { status, headers }));
    await expect(
      fetchExpectedHealthAfterDeployment({
        ...options,
        fetchImpl,
        attempts: 3,
      }),
    ).rejects.toThrow(message);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("backs off rate limits/challenges and reports success only after real health", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "3" } }))
      .mockResolvedValueOnce(new Response("html", { headers: { "cf-mitigated": "challenge" } }))
      .mockResolvedValueOnce(Response.json(payload));
    const sleep = vi.fn(async (_delay: number) => undefined);
    const result = await fetchExpectedHealthAfterDeployment({ ...options, fetchImpl, sleep });
    expect(result.attempts).toBe(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([1_000, 3_000, 2_000]);
  });

  it("honors a bounded deadline without retrying early after Retry-After", async () => {
    let clock = 0;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 429, headers: { "Retry-After": "600" } }));
    await expect(
      fetchExpectedHealthAfterDeployment({
        ...options,
        fetchImpl,
        now: () => clock,
        sleep: async (delay) => {
          clock += delay;
        },
      }),
    ).rejects.toThrow("rate limited");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not log reflected payloads or credential-bearing fetch exceptions", async () => {
    for (const fetchImpl of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error(token)),
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: token }, { status: 403 })),
    ]) {
      await expect(
        fetchExpectedHealthAfterDeployment({
          ...options,
          fetchImpl,
          attempts: 1,
        }),
      ).rejects.not.toThrow(token);
    }
  });
});

describe("authenticated transport readiness for corrective operations", () => {
  it("readiness accepts an older valid contract but full verification does not", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        ok: true,
        schemaContractVersion: 1,
        acceptedRecoveryVersions: [1],
        acceptedRecoveryPolicyVersions: ["ladder_v1"],
      }),
    );
    await expect(
      fetchExpectedHealthAfterDeployment({
        ...options,
        fetchImpl,
        expectedContractVersion: null,
      }),
    ).resolves.toMatchObject({ response: { status: 200 } });
    await expect(
      fetchExpectedHealthAfterDeployment({
        ...options,
        fetchImpl,
        attempts: 1,
      }),
    ).rejects.toThrow("deployment propagation");
  });

  it.each([
    [503, "database_schema_not_ready", true],
    [503, "telemetry_budget_disabled", false],
    [500, "internal_error", undefined],
    [502, "service_unavailable", undefined],
    [400, "bad_backend_request", undefined],
    [503, "unknown_backend_error", false],
  ])(
    "allows an authorized corrective operation from %s %s, then requires healthy recovery",
    async (status, error, retryable) => {
      let recovered = false;
      const correction = vi.fn(async () => {
        recovered = true;
      });
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
        recovered
          ? Response.json({
              ...payload,
              acceptedRecoveryVersions: [1],
              acceptedRecoveryPolicyVersions: ["ladder_v1"],
            })
          : Response.json({ error, retryable }, { status }),
      );
      const ready = await fetchExpectedHealthAfterDeployment({
        ...options,
        fetchImpl,
        expectedContractVersion: null,
      });
      expect(ready.response.status).toBe(status);
      expect(ready.payload.error).toBe(error);
      await correction();
      const verified = await fetchExpectedHealthAfterDeployment({ ...options, fetchImpl });
      expect(verified.response.status).toBe(200);
      expect(correction).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it("does not run a corrective operation when authenticated transport is not established", async () => {
    const correction = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ error: "not_found" }, { status: 404 }));
    async function recover() {
      await fetchExpectedHealthAfterDeployment({
        ...options,
        fetchImpl,
        expectedContractVersion: null,
        attempts: 2,
      });
      await correction();
      await fetchExpectedHealthAfterDeployment({ ...options, fetchImpl });
    }
    await expect(recover()).rejects.toThrow("authentication/routing uncertainty");
    expect(correction).not.toHaveBeenCalled();
  });

  it.each([
    [200, { ok: true, schemaContractVersion: 6 }],
    [200, { ok: false, schemaContractVersion: 6 }],
    [500, {}],
    [500, { error: "" }],
    [500, { error: "   " }],
    [500, { error: 123 }],
    [500, { error: "internal_error", retryable: "true" }],
    [500, { error: "internal_error", ok: true }],
    [503, { error: "telemetry_budget_disabled", retryable: null }],
    [302, { error: "internal_error" }],
  ])("does not accept malformed/redirect readiness envelopes: %s %j", async (status, body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
    await expect(
      fetchExpectedHealthAfterDeployment({
        ...options,
        fetchImpl,
        expectedContractVersion: null,
        attempts: 1,
      }),
    ).rejects.toThrow();
  });

  it.each([
    [429, {}, "rate limited"],
    [200, { "cf-mitigated": "challenge" }, "challenge"],
  ])("does not bypass %s transport safeguards for recovery", async (status, headers, message) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("not backend health", { status, headers }));
    await expect(
      fetchExpectedHealthAfterDeployment({
        ...options,
        fetchImpl,
        expectedContractVersion: null,
        attempts: 2,
      }),
    ).rejects.toThrow(message);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("gateway transport failures", () => {
  it.each([
    [503, "service_unavailable"],
    [502, "service_not_configured"],
    [503, "service_not_configured"],
  ])(
    "classifies gateway %s %s as unavailable transport, not backend health",
    async (status, error) => {
      for (const expectedContractVersion of [null, 6]) {
        const fetchImpl = vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ error }, { status }));
        await expect(
          fetchExpectedHealthAfterDeployment({
            ...options,
            fetchImpl,
            expectedContractVersion,
          }),
        ).rejects.toBeInstanceOf(HealthTransportError);
        expect(fetchImpl).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    [500, "internal_error"],
    [502, "service_unavailable"],
    [400, "bad_backend_request"],
  ])("still rejects %s %s during full verification", async (status, error) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error }, { status }));
    await expect(
      fetchExpectedHealthAfterDeployment({
        ...options,
        fetchImpl,
        attempts: 1,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("hard-fails the pinned Node gateway redirect rejection without a retry", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new TypeError("fetch failed", { cause: new Error("unexpected redirect") }),
      );
    await expect(
      fetchExpectedHealthAfterDeployment({
        ...options,
        fetchImpl,
      }),
    ).rejects.toThrow("verification unavailable (transport): redirect rejected");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});
