import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("forecast canary CLI", () => {
  it("accepts a structurally valid in-progress report while CPU evidence is pending", async () => {
    const report = inProgressReport();
    const { result, outputPath } = await runCli(report);

    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ passed: false, quota: { valid: false } });
    expect(await readFile(outputPath, "utf8")).toContain(
      "canary_quota_error=cloudflare_paid_cpu_budget:missing:collection-kit-usage-guard",
    );
    expect(await readFile(outputPath, "utf8")).toContain("canary_quota_valid=false");
    expect(await readFile(outputPath, "utf8")).toContain("canary_passed=false");
  });

  it("still rejects a malformed quota failure payload", async () => {
    const validReport = inProgressReport();
    const report = { ...validReport, quota: { ...validReport.quota, evidence: {} } };

    await expect(runCli(report)).rejects.toMatchObject({
      stderr: expect.stringContaining("Canary report schema is invalid."),
    });
  });
});

async function runCli(report: unknown) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(report));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing_test_server_address");
  const directory = await mkdtemp(join(tmpdir(), "forecast-canary-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "github-output.txt");
  const result = await execFileAsync(process.execPath, ["scripts/check-forecast-canary.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FORECAST_COLLECTOR_URL: `http://127.0.0.1:${address.port}`,
      FORECAST_COLLECTOR_ADMIN_TOKEN: "test-token",
      GITHUB_OUTPUT: outputPath,
    },
  });
  return { result, outputPath };
}

function inProgressReport() {
  return {
    version: 8,
    canaryId: `fc-${"a".repeat(32)}`,
    deploymentSha: "b".repeat(40),
    environment: "staging",
    pollMode: "both",
    acceptance: {
      windowMode: "fixed_8_hours",
      windowHours: 8,
      minimumDeliveryRate: 0.99,
      minimumCompletionRate: 0.99,
      maximumMissingSlots: 1,
    },
    window: {
      startedAt: "2026-09-02T09:32:10.000Z",
      endsAt: "2026-09-02T17:32:10.000Z",
      observedUntil: "2026-09-02T09:41:06.000Z",
      eligible: false,
      earlyFailure: false,
      earlyFailureReasons: [],
    },
    collector: invocationSummary(),
    dispatcher: {
      ...invocationSummary(),
      duplicateDispatches: 0,
      duplicateRuns: 0,
      invalidStates: 0,
      smokeCount: 1,
      invalidSmoke: 0,
      passed: false,
    },
    router: {
      routerTestCount: 0,
      duplicateInteractions: 0,
      maxInitialResponseMs: 0,
      failedAuthorizationSmoke: 0,
      passed: false,
    },
    quota: {
      valid: false,
      errorCode: "cloudflare_paid_cpu_budget:missing:collection-kit-usage-guard",
      evidence: null,
      evidenceHash: "c".repeat(64),
      initialEvidenceHash: "d".repeat(64),
      freshnessMinutes: null,
      cpu: null,
    },
    invariants: { totalInvalid: 0 },
    passed: false,
  };
}

function invocationSummary() {
  return {
    expectedSlots: 3,
    observedSlots: 3,
    missingSlots: 0,
    deliveryRate: 1,
    completed: 3,
    abandoned: 0,
    completionRate: 1,
    duplicateInvocations: 0,
    unexpectedInvocations: 0,
    lateInvocations: 0,
    latestStatus: "completed",
  };
}
