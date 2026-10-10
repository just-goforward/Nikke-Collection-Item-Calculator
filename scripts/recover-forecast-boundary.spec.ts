import { describe, expect, it, vi } from "vitest";
import { boundaryRecoveryRequest, executeBoundaryRecovery } from "./recover-forecast-boundary.ts";

const settings = {
  url: "https://collector-staging.example",
  token: "private-test-credential",
  deploymentSha: "a".repeat(40),
};
const body = boundaryRecoveryRequest("56", "8143799");
if (!body) throw new Error("Missing test request");

describe("staging proven-boundary recovery command", () => {
  it("defaults to no mutation and supports only explicit board and exact marker inputs", () => {
    expect(boundaryRecoveryRequest("none", "")).toBeNull();
    expect(body).toEqual({
      mode: "recover-boundary",
      environment: "staging",
      source: "naver-board-56",
      expectedCommittedItemId: "8143799",
    });
    expect(boundaryRecoveryRequest("48", "8289927")?.source).toBe("naver-board-48");
    for (const [source, marker] of [
      ["none", "8143799"],
      ["56", ""],
      ["production", "1"],
      ["56", "0"],
      ["56", "1; echo injected"],
      ["56", "1".repeat(21)],
      ["56", " 8143799"],
    ])
      expect(() => boundaryRecoveryRequest(source ?? "", marker ?? "")).toThrow("inputs_invalid");
  });

  it("uses an authenticated staging deployment check and exactly one bounded, nonredirected POST", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ environment: "staging", deploymentSha: settings.deploymentSha }),
      )
      .mockResolvedValueOnce(
        Response.json({
          recovered: true,
          source: body.source,
          queuedItems: 21,
          ignored: settings.token,
        }),
      );
    await expect(executeBoundaryRecovery(body, settings, fetcher)).resolves.toEqual({
      recovered: true,
      source: body.source,
      queuedItems: 21,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1] ?? [];
    expect(String(url)).toBe("https://collector-staging.example/admin/source-queue/process");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${settings.token}` },
      body: JSON.stringify(body),
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["deployment", "environment", "denied", "network", "oversize"])(
    "never mutates or retries after a %s preflight failure",
    async (kind) => {
      const fetcher = vi.fn<typeof fetch>();
      if (kind === "network") fetcher.mockRejectedValue(new Error(settings.token));
      else if (kind === "denied")
        fetcher.mockResolvedValue(new Response(settings.token, { status: 403 }));
      else if (kind === "oversize")
        fetcher.mockResolvedValue(new Response("x", { headers: { "content-length": "1000001" } }));
      else
        fetcher.mockResolvedValue(
          Response.json({
            environment: kind === "environment" ? "production" : "staging",
            deploymentSha: kind === "deployment" ? "b".repeat(40) : settings.deploymentSha,
          }),
        );
      await expect(executeBoundaryRecovery(body, settings, fetcher)).rejects.toThrow(
        "forecast_boundary_recovery_",
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
    },
  );

  it("does not retry a failed or ambiguous mutation", async () => {
    for (const response of [
      new Response(settings.token, { status: 409 }),
      Response.json({ recovered: true, source: "naver-board-48", queuedItems: 0 }),
      Response.json({ recovered: true, source: body.source, queuedItems: 41 }),
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({ environment: "staging", deploymentSha: settings.deploymentSha }),
        )
        .mockResolvedValueOnce(response);
      await expect(executeBoundaryRecovery(body, settings, fetcher)).rejects.toThrow(
        "forecast_boundary_recovery_",
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
});
