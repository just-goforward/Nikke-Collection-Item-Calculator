import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchApprovedStagingAdoption,
  parseApprovedStagingAdoption,
} from "./read-approved-staging-adoption.ts";
import {
  recordSelectionDisposition,
  StagingForecastEligibilityError,
} from "./staging-adoption-eligibility.ts";

beforeEach(() => {
  vi.stubEnv("DISCORD_APPROVAL_MODE", "staging_adoption");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

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
  it.each([
    undefined,
    "disabled",
    "test",
    "staging_adoption ",
    "STAGING_ADOPTION",
    "Staging_Adoption",
  ])("withholds lookup and disposition before network work in mode %s", async (mode) => {
    vi.stubEnv("DISCORD_APPROVAL_MODE", mode);
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      fetchApprovedStagingAdoption({
        collectorUrl: "https://collector.example",
        adminToken: "secret",
        fetchImpl,
      }),
    ).rejects.toThrow("staging_adoption_disabled");
    await expect(
      recordSelectionDisposition(
        approved.approvalId,
        new StagingForecastEligibilityError("registry_forecast_ineligible"),
        fetchImpl,
      ),
    ).rejects.toThrow("staging_adoption_disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [".github/workflows/request-staging-forecast-adoption.yml", "send"],
    [".github/workflows/process-staging-forecast-adoption.yml", "process"],
  ])("requires exact adoption mode before any external-work step in %s", (path, job) => {
    const source = readFileSync(path, "utf8");
    expect(source).toContain(
      `jobs:\n  ${job}:\n    if: \${{ vars.DISCORD_APPROVAL_MODE == 'staging_adoption' }}\n`,
    );
    expect(source).toContain("  DISCORD_APPROVAL_MODE: ${{ vars.DISCORD_APPROVAL_MODE }}");
    const firstStep = source.match(
      / {4}steps:\n {6}- name: Require exact staging adoption mode\n {8}shell: bash\n {8}run: \|\n((?: {10}[^\n]*\n)+)/,
    );
    if (!firstStep?.[1]) throw new Error("Exact mode guard is not the first workflow step");
    const guard = firstStep[1].replace(/^ {10}/gm, "");
    expect(guard).not.toContain("${{");
    for (const mode of [
      undefined,
      "",
      "disabled",
      "test",
      "staging_adoption ",
      "STAGING_ADOPTION",
      "Staging_Adoption",
      "staging_adoption",
    ]) {
      const env = { ...process.env };
      if (mode === undefined) delete env["DISCORD_APPROVAL_MODE"];
      else env["DISCORD_APPROVAL_MODE"] = mode;
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-c", `${guard}\nprintf 'external_work_reached\\n'\n`],
        { env, encoding: "utf8", timeout: 5_000 },
      );
      if (result.error) throw result.error;
      expect(result.status, mode ?? "absent").toBe(mode === "staging_adoption" ? 0 : 1);
      expect(result.stdout).toBe(mode === "staging_adoption" ? "external_work_reached\n" : "");
      expect(result.stderr).toBe(mode === "staging_adoption" ? "" : "staging_adoption_disabled\n");
    }
  });

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
