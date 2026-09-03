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

describe("forecast canary v10 CLI", () => {
  it("accepts a structurally valid incomplete report without calling it failed", async () => {
    const { result, outputPath } = await runCli(inProgressReport());
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      certification: { status: "incomplete" },
      evidence: { status: "incomplete" },
    });
    const output = await readFile(outputPath, "utf8");
    expect(output).toContain("canary_status=incomplete");
    expect(output).toContain("canary_promotable=false");
    expect(output).toContain("canary_evidence_status=incomplete");
  });

  it("allows passed_with_warning to reach only the external approval boundary", async () => {
    const report = inProgressReport();
    report.window.eligible = true;
    report.evidence = { status: "valid", errors: [] };
    report.functional = gate("passed");
    report.integrity = gate("passed");
    report.quota = gate("passed");
    report.runtimeSafety = gate("passed");
    report.certification = {
      status: "passed_with_warning",
      hardFailures: [],
      warnings: ["runtime_p99_headroom_low:dispatcher"],
    };
    const { outputPath } = await runCli(report);
    const output = await readFile(outputPath, "utf8");
    expect(output).toContain("canary_status=passed_with_warning");
    expect(output).toContain("canary_promotable=true");
  });

  it("rejects an inconsistent failed certificate without hard evidence", async () => {
    const report = inProgressReport();
    report.certification = { status: "failed", hardFailures: [], warnings: [] };
    await expect(runCli(report)).rejects.toMatchObject({
      stderr: expect.stringContaining("Failed canary has no hard failure evidence."),
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
  const directory = await mkdtemp(join(tmpdir(), "forecast-canary-v10-"));
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
  const sha = "b".repeat(40);
  const canaryId = `fc-${"a".repeat(32)}`;
  const collectorVersionId = "11111111-1111-4111-8111-111111111111";
  const dispatcherVersionId = "22222222-2222-4222-8222-222222222222";
  return {
    version: 10,
    policyId: "forecast-canary-v10-live-contract-v1",
    canaryId,
    deploymentSha: sha,
    environment: "staging",
    pollMode: "both",
    identity: {
      canaryId,
      deploymentSha: sha,
      collectorScriptVersion: `${sha}-both-v10`,
      dispatcherScriptVersion: `${sha}-v10`,
      collectorScriptVersionId: collectorVersionId,
      dispatcherScriptVersionId: dispatcherVersionId,
      startedAt: "2026-09-02T09:32:10.000Z",
      endedAt: "2026-09-02T17:32:10.000Z",
    },
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
    quotaEvidence: {
      valid: false,
      errorCode: "cloudflare_paid_final_evidence_required",
      evidence: null,
      evidenceHash: "c".repeat(64),
      initialEvidenceHash: "d".repeat(64),
      freshnessMinutes: null,
      policy: null,
      accountRuntime: null,
    },
    invariants: { totalInvalid: 0 },
    evidence: {
      status: "incomplete",
      errors: ["cloudflare_paid_final_evidence_required", "runtime_telemetry_not_object"],
    },
    functional: gate("incomplete"),
    integrity: gate("passed"),
    quota: gate("incomplete"),
    runtimeSafety: gate("incomplete"),
    performance: {
      status: "baseline_bootstrap",
      baselineId: null,
      warnings: ["performance_evidence_incomplete"],
      regressionCodes: [],
      sampleHash: "e".repeat(64),
      collector: cpuPerformance("collection-kit-forecast-collector-staging", 50),
      dispatcher: cpuPerformance("collection-kit-forecast-dispatcher-staging", 25),
    },
    certification: {
      status: "incomplete",
      hardFailures: [],
      warnings: ["performance_evidence_incomplete"],
    },
  };
}

function gate(status: "passed" | "failed" | "incomplete") {
  return { status, failureCodes: status === "failed" ? ["fixture_failure"] : [] };
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

function cpuPerformance(scriptName: string, configuredLimitMs: number) {
  const distribution = {
    samples: 0,
    averageMs: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    maxMs: 0,
  };
  return {
    scriptName,
    configuredLimitMs,
    expectedSlots: 0,
    d1ObservedSlots: 0,
    telemetryObservedSlots: 0,
    missingTelemetrySlots: 0,
    coverage: 0,
    exceededCpu: 0,
    unsuccessfulOutcomes: 0,
    duplicateSlots: 0,
    unmatchedTelemetrySlots: 0,
    markerOnlyIdentities: 0,
    versionIdOnlyIdentities: 0,
    full: distribution,
    firstHalf: distribution,
    secondHalf: distribution,
    p99LimitRatio: 0,
  };
}
