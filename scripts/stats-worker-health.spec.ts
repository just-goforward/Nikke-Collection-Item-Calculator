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
