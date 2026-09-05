import { describe, expect, it, vi } from "vitest";
import {
  fetchApprovedStagingAdoption,
  parseApprovedStagingAdoption,
} from "./read-approved-staging-adoption.ts";

const approved = {
  approvalId: "discord-staging-00000000-0000-0000-0000-000000000000",
  forecastId: "supply-2026-08-28-v1",
  sourcePullRequestNumber: 13,
  sourceHeadSha: "a".repeat(40),
  registrySha: "b".repeat(40),
  researchRunId: 123,
  researchArtifactName: "dynamic-hp-exact-gate-summary-123",
  researchArtifactDigest: "c".repeat(64),
};

describe("approved staging adoption lookup", () => {
  it("treats an empty deployed endpoint as no work", async () => {
    const result = await fetchApprovedStagingAdoption({
      collectorUrl: "https://collector.example",
      adminToken: "secret",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ adoptions: [] })),
    });

    expect(result).toBeNull();
  });

  it("retries a propagation 404 instead of treating it as no work", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ adoptions: [approved] }));
    const sleep = vi.fn(async () => undefined);

    const result = await fetchApprovedStagingAdoption({
      collectorUrl: "https://collector.example/",
      adminToken: "secret",
      attempts: 2,
      delayMs: 1,
      requestTimeoutMs: 50,
      fetchImpl,
      sleep,
    });

    expect(result).toEqual(approved);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("fails after a bounded propagation retry window", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    const sleep = vi.fn(async () => undefined);

    await expect(
      fetchApprovedStagingAdoption({
        collectorUrl: "https://collector.example",
        adminToken: "secret",
        attempts: 3,
        delayMs: 1,
        fetchImpl,
        sleep,
      }),
    ).rejects.toThrow("did not become ready after 3 attempts (HTTP 404)");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fails closed for malformed and oversized payloads", async () => {
    expect(() => parseApprovedStagingAdoption({ adoption: [approved] })).toThrow(
      "Invalid staging adoption response envelope",
    );
    await expect(
      fetchApprovedStagingAdoption({
        collectorUrl: "https://collector.example",
        adminToken: "secret",
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ adoptions: [], padding: "x".repeat(140 * 1024) })),
      }),
    ).rejects.toThrow("staging_adoption_response_invalid");
  });

  it("does not retry an authentication or contract route failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    const sleep = vi.fn(async () => undefined);

    await expect(
      fetchApprovedStagingAdoption({
        collectorUrl: "https://collector.example",
        adminToken: "secret",
        attempts: 3,
        delayMs: 1,
        fetchImpl,
        sleep,
      }),
    ).rejects.toThrow("returned HTTP 403");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});
