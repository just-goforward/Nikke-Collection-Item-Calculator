import { describe, expect, it, vi } from "vitest";

import { fetchExpectedHealthAfterDeployment } from "./stats-worker-health";

function endpointUrl(path: string) {
  return new URL(path, "https://worker.example/");
}

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
      delayMs: 1_000,
      endpointUrl,
      expectedContractVersion: 2,
      fetchImpl,
      sleep,
    });

    expect(result.payload).toEqual({ ok: true, schemaContractVersion: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
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
      delayMs: 1_000,
      endpointUrl,
      expectedContractVersion: 2,
      fetchImpl,
      sleep,
    });

    expect(result.response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
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
        delayMs: 1_000,
        endpointUrl,
        expectedContractVersion: 2,
        fetchImpl,
        maxResponseBytes: 256,
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
      delayMs: 1,
      endpointUrl,
      expectedContractVersion: 2,
      fetchImpl,
      requestTimeoutMs: 50,
      sleep,
    });

    expect(result.response.status).toBe(200);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(sleep).toHaveBeenCalledOnce();
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
      delayMs: 1_000,
      endpointUrl,
      expectedContractVersion: 2,
      fetchImpl,
      sleep,
    });

    expect(result.payload).toEqual({ ok: true, schemaContractVersion: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
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
        delayMs: 1_000,
        endpointUrl,
        expectedContractVersion: 2,
        fetchImpl,
        sleep,
      }),
    ).rejects.toThrow("deployment propagation retry exhausted");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
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
        delayMs: 1_000,
        endpointUrl,
        expectedContractVersion: 2,
        fetchImpl,
        sleep,
      }),
    ).rejects.toThrow("database_schema_not_ready");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});
