import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stableJson } from "../forecast-collector/src/crypto.ts";
import { evaluateD1PreflightBudget } from "../shared/cloudflarePaidUsage.ts";
import { D1_DATABASE_IDS } from "../shared/d1QuotaEvidence.ts";
import { FORECAST_RUNTIME_TELEMETRY_SOURCE } from "../shared/forecastCanaryRuntime.ts";

import {
  activeVersionId,
  assertRouterOrigin,
  deploymentVersionId,
  renderForecastCertificationSummary,
  renderForecastIdentitySummary,
  routerBootstrapPrior,
  sanitizedBaselineCandidate,
  sanitizedCanaryIdentity,
  sanitizedCertificationEvidence,
  sanitizedQuotaBaseline,
  sanitizedQuotaEvaluation,
  sanitizedReadiness,
  sanitizedRuntimeEvidence,
  sanitizedWorkerIdentity,
  validateWorkflowSource,
  workerVersionIdentity,
} from "./check-workflow-hardening";

const PINNED_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const VERSION = "12345678-1234-1234-1234-123456789abc";

function routerBootstrapFixture(tag = "staging", flag = "false") {
  const discord = {
    APPLICATION_ID: "111111",
    PUBLIC_KEY: "ab".repeat(32),
    GUILD_ID: "222222",
    APPROVER_USER_ID: "333333",
    APPROVAL_CHANNEL_ID: "444444",
    ALERT_CHANNEL_ID: "555555",
    ACTIVITY_CHANNEL_ID: "666666",
  };
  return {
    value: {
      id: VERSION,
      annotations: { "workers/tag": `${PINNED_SHA}-${tag}` },
      resources: {
        bindings: [
          { name: "DEPLOY_SHA", type: "plain_text", text: PINNED_SHA },
          { name: "PRODUCTION_MUTATIONS_ENABLED", type: "plain_text", text: flag },
          ...Object.entries(discord).map(([suffix, text]) => ({
            name: `DISCORD_${suffix}`,
            type: "plain_text",
            text,
          })),
        ],
      },
    },
    expected: {
      ...Object.fromEntries(
        Object.entries(discord).map(([suffix, text]) => [`DISCORD_FORECAST_${suffix}`, text]),
      ),
      ROUTER_BOOTSTRAP_ANCESTRY: "0",
    } as Record<string, string>,
  };
}

describe("Offline Router bootstrap gates", () => {
  it.each(["staging", "production-disabled"])("accepts disabled %s without relabelling", (tag) => {
    const { value, expected } = routerBootstrapFixture(tag);
    expected["DISCORD_FORECAST_PUBLIC_KEY"] =
      expected["DISCORD_FORECAST_PUBLIC_KEY"]?.toUpperCase() ?? "";
    expect(() => routerBootstrapPrior(value, VERSION, expected)).not.toThrow();
    expect(workerVersionIdentity(value, VERSION)).toMatchObject({
      versionId: VERSION,
      deploymentSha: PINNED_SHA,
      tag: `${PINNED_SHA}-${tag}`,
      vars: { PRODUCTION_MUTATIONS_ENABLED: "false" },
    });
  });

  it.each([
    ["production-enabled", "true"],
    ["production-enabled", "false"],
    ["production-disabled", "true"],
    ["staging", "true"],
    ["staging", "FALSE"],
    ["unknown", "false"],
  ])("rejects tag=%s flag=%s", (tag, flag) => {
    const { value, expected } = routerBootstrapFixture(tag, flag);
    expect(() => routerBootstrapPrior(value, VERSION, expected)).toThrow(
      "forecast_router_bootstrap_prior_not_disabled",
    );
  });

  it.each([
    "APPLICATION_ID",
    "PUBLIC_KEY",
    "GUILD_ID",
    "APPROVER_USER_ID",
    "APPROVAL_CHANNEL_ID",
    "ALERT_CHANNEL_ID",
    "ACTIVITY_CHANNEL_ID",
  ])("rejects changed Discord %s without disclosing values", (suffix) => {
    const { value, expected } = routerBootstrapFixture();
    expected[`DISCORD_FORECAST_${suffix}`] = suffix === "PUBLIC_KEY" ? "cd".repeat(32) : "999999";
    expect(() => routerBootstrapPrior(value, VERSION, expected)).toThrow(
      `forecast_router_bootstrap_discord_mismatch:DISCORD_${suffix}`,
    );
  });

  it("permits only a successful live-SHA ancestry result, rejecting divergence and Git errors", () => {
    const { value, expected } = routerBootstrapFixture();
    expect(() => routerBootstrapPrior(value, VERSION, expected)).not.toThrow();
    for (const status of ["1", "128", "", "false"]) {
      expected["ROUTER_BOOTSTRAP_ANCESTRY"] = status;
      expect(() => routerBootstrapPrior(value, VERSION, expected)).toThrow(
        "forecast_router_bootstrap_not_descendant",
      );
    }
  });
});

const privateMetadata = {
  author_email: "private-person@example.test",
  account: "private-account",
  applicationId: "private-application",
  guildId: "private-guild",
  channelId: "private-channel",
  arguments: ["private-argument"],
  vars: { PRIVATE: "private-variable" },
  tag: "private-tag",
};
const artifactWindow = {
  startedAt: "2026-10-01T00:00:00.000Z",
  endsAt: "2026-10-01T08:00:00.000Z",
};

function hashEvidence(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function runtimeArtifactFixture() {
  return {
    version: 2,
    source: FORECAST_RUNTIME_TELEMETRY_SOURCE,
    canaryId: `fc-${"a".repeat(32)}`,
    deploymentSha: PINNED_SHA,
    collectorScriptVersion: `${PINNED_SHA}-both-v10`,
    dispatcherScriptVersion: `${PINNED_SHA}-v10`,
    collectorScriptVersionId: VERSION,
    dispatcherScriptVersionId: VERSION,
    startedAt: artifactWindow.startedAt,
    endedAt: artifactWindow.endsAt,
    observedAt: artifactWindow.endsAt,
    ...privateMetadata,
    workers: (["collector", "dispatcher"] as const).map((component) => ({
      component,
      scriptName: `collection-kit-forecast-${component}-staging`,
      configuredLimitMs: component === "collector" ? 50 : 25,
      headSamplingRate: 1,
      ...privateMetadata,
      samples: [
        {
          slot: artifactWindow.startedAt,
          requestIdHash: "f".repeat(64),
          scriptVersionId: VERSION,
          scriptVersionTag: "private-version-tag",
          identitySource: "tag",
          eventType: "scheduled",
          cpuTimeMs: 3.25,
          outcome: "ok",
          ...privateMetadata,
        },
      ],
    })),
  };
}

function quotaArtifactFixture() {
  const worker = {
    scriptName: "collection-kit-forecast-collector-staging",
    requestsObserved: 120,
    cpuMsObserved: 240,
    errorsObserved: 0,
    exceededCpuObserved: 0,
    cpuTimeAverageMs: 2,
    cpuTimeP95Ms: 3,
    cpuTimeP99Ms: 4,
    ...privateMetadata,
  };
  const snapshot = {
    version: 2 as const,
    source: "cloudflare-paid-account-analytics-v2" as const,
    accountId: "d".repeat(32),
    capturedAt: artifactWindow.endsAt,
    plan: {
      id: "workers-paid" as const,
      verified: true as const,
      state: "Paid" as const,
      frequency: "monthly" as const,
      periodStart: artifactWindow.startedAt,
      periodEnd: "2026-11-01T00:00:00.000Z",
      subscriptionId: "private-subscription",
      ratePlanId: "private-rate-plan",
      ...privateMetadata,
    },
    daily: [
      {
        date: "2026-10-01",
        workerRequests: 120,
        workerCpuMs: 240,
        d1RowsRead: 7,
        d1RowsWritten: 7,
        ...privateMetadata,
      },
    ],
    databases: Object.values(D1_DATABASE_IDS).map((databaseId) => ({
      databaseId,
      databaseName: "private-database",
      rowsReadObserved: 1,
      rowsWrittenObserved: 1,
      storageBytesObserved: 1,
      ...privateMetadata,
    })),
    workers: [worker],
    workerRuntime: {
      startedAt: artifactWindow.startedAt,
      endedAt: artifactWindow.endsAt,
      workers: [worker],
      ...privateMetadata,
    },
    ...privateMetadata,
  };
  return { snapshot, evaluation: evaluateD1PreflightBudget(snapshot) };
}

function approvalPerformanceFixture() {
  const distribution = {
    samples: 120,
    averageMs: 2,
    p50Ms: 1,
    p95Ms: 3,
    p99Ms: 4,
    maxMs: 5,
    ...privateMetadata,
  };
  return {
    configuredLimitMs: 50,
    expectedSlots: 160,
    d1ObservedSlots: 160,
    telemetryObservedSlots: 160,
    missingTelemetrySlots: 0,
    coverage: 1,
    runtimeObservedSlots: 160,
    missingRuntimeSlots: 0,
    runtimeCoverage: 1,
    exceededCpu: 0,
    unsuccessfulOutcomes: 0,
    duplicateSlots: 0,
    unmatchedTelemetrySlots: 0,
    markerOnlyIdentities: 0,
    versionIdOnlyIdentities: 0,
    full: distribution,
    firstHalf: distribution,
    secondHalf: distribution,
    p99LimitRatio: 0.08,
    ...privateMetadata,
  };
}

function certificationArtifactFixture() {
  const runtime = runtimeArtifactFixture();
  const { evaluation } = quotaArtifactFixture();
  const invocation = {
    expectedSlots: 160,
    observedSlots: 160,
    missingSlots: 0,
    deliveryRate: 1,
    completed: 160,
    abandoned: 0,
    completionRate: 1,
    duplicateInvocations: 0,
    unexpectedInvocations: 0,
    lateInvocations: 0,
    latestStatus: "completed",
    ...privateMetadata,
  };
  const gate = { status: "passed", failureCodes: [], ...privateMetadata };
  const report = {
    version: 10,
    policyId: "forecast-canary-v10-live-contract-v1",
    canaryId: runtime.canaryId,
    deploymentSha: PINNED_SHA,
    pollMode: "both",
    identity: {
      collectorScriptVersionId: VERSION,
      dispatcherScriptVersionId: VERSION,
      collectorScriptVersion: runtime.collectorScriptVersion,
      dispatcherScriptVersion: runtime.dispatcherScriptVersion,
      ...privateMetadata,
    },
    acceptance: {
      windowMode: "fixed_8_hours",
      windowHours: 8,
      minimumDeliveryRate: 0.99,
      minimumCompletionRate: 0.99,
      maximumMissingSlots: 1,
      ...privateMetadata,
    },
    window: { ...artifactWindow, eligible: true, earlyFailure: false, ...privateMetadata },
    collector: invocation,
    dispatcher: {
      ...invocation,
      duplicateDispatches: 0,
      duplicateRuns: 0,
      invalidStates: 0,
      smokeCount: 1,
      invalidSmoke: 0,
      passed: true,
    },
    router: {
      routerTestCount: 1,
      duplicateInteractions: 0,
      maxInitialResponseMs: 250,
      failedAuthorizationSmoke: 0,
      passed: true,
      ...privateMetadata,
    },
    invariants: {
      queue: 0,
      cursors: 0,
      candidates: 0,
      watermarks: 0,
      reviews: 0,
      manualReviewCoverage: 0,
      callbackStateConflicts: 0,
      unsentCriticalAlerts: 0,
      totalInvalid: 0,
      ...privateMetadata,
    },
    evidence: { status: "valid", errors: [], ...privateMetadata },
    functional: gate,
    integrity: gate,
    quota: gate,
    runtimeSafety: gate,
    performance: {
      status: "baseline_bootstrap",
      warnings: ["performance_baseline_bootstrap"],
      regressionCodes: [],
      sampleHash: hashEvidence(runtime),
      collector: approvalPerformanceFixture(),
      dispatcher: approvalPerformanceFixture(),
      ...privateMetadata,
    },
    certification: {
      status: "passed_with_warning",
      hardFailures: [],
      warnings: ["performance_baseline_bootstrap"],
      ...privateMetadata,
    },
    quotaEvidence: {
      valid: true,
      errorCode: null,
      evidence: evaluation.evidence,
      evidenceHash: hashEvidence(evaluation.evidence),
      initialEvidenceHash: "e".repeat(64),
      freshnessMinutes: 0,
      policy: { passed: true, failureCodes: [], ...privateMetadata },
      accountRuntime: gate,
      ...privateMetadata,
    },
    ...privateMetadata,
  };
  return { runtime, report };
}

function assertArtifactPrivacy(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const marker of [
    "private-",
    "author_email",
    "applicationId",
    "guildId",
    "channelId",
    "scriptVersionTag",
    "subscriptionId",
    "ratePlanId",
    "accountId",
    "arguments",
    '"vars":',
    '"tag":',
  ])
    expect(serialized).not.toContain(marker);
}

describe("Privacy-safe certificate and CPU artifact projections", () => {
  it("preserves CPU gates, warnings and original hash references without personal or account metadata", () => {
    const { runtime, report } = certificationArtifactFixture();
    const artifact = sanitizedCertificationEvidence(report);
    const cpu = sanitizedRuntimeEvidence(runtime, report);
    assertArtifactPrivacy(artifact);
    assertArtifactPrivacy(cpu);
    expect(artifact.sourceHash).toBe(hashEvidence(report));
    expect(artifact.projectionHash).toBe(hashEvidence(artifact.data));
    expect(artifact.data.certification).toEqual({
      status: "passed_with_warning",
      hardFailures: [],
      warnings: ["performance_baseline_bootstrap"],
    });
    expect(artifact.data.performance.collector.full).toEqual({
      samples: 120,
      averageMs: 2,
      p50Ms: 1,
      p95Ms: 3,
      p99Ms: 4,
      maxMs: 5,
    });
    expect(artifact.data.performance.collector.runtimeCoverage).toBe(1);
    expect(artifact.data.performance.sampleHash).toBe(cpu.sourceHash);
    expect(cpu.projectionHash).toBe(hashEvidence(cpu.data));
    expect(cpu.data.workers[0]?.samples[0]).toEqual({
      slot: artifactWindow.startedAt,
      requestIdHash: "f".repeat(64),
      scriptVersionId: VERSION,
      identitySource: "tag",
      eventType: "scheduled",
      cpuTimeMs: 3.25,
      outcome: "ok",
    });
    expect(artifact.data.window).toEqual({
      ...artifactWindow,
      eligible: true,
      earlyFailure: false,
    });
    expect(artifact.data.quotaEvidence.evidence?.workerRuntime.workers[0]?.projectWorker).toBe(
      "collection-kit-forecast-collector-staging",
    );
  });
  it("rejects mismatched original runtime/quota hashes and malformed essential CPU fields", () => {
    const { runtime, report } = certificationArtifactFixture();
    expect(() =>
      sanitizedRuntimeEvidence({ ...runtime, observedAt: "2026-10-01T09:00:00.000Z" }, report),
    ).toThrow("forecast_retained_runtime_hash_mismatch");
    expect(() =>
      sanitizedCertificationEvidence({
        ...report,
        quotaEvidence: { ...report.quotaEvidence, evidenceHash: "0".repeat(64) },
      }),
    ).toThrow("forecast_retained_quota_hash_mismatch");
    expect(() =>
      sanitizedCertificationEvidence({
        ...report,
        performance: {
          ...report.performance,
          collector: {
            ...report.performance.collector,
            full: { ...report.performance.collector.full, p95Ms: "3" },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      sanitizedCertificationEvidence({
        ...report,
        certification: { ...report.certification, warnings: ["private-person@example.test"] },
      }),
    ).toThrow();
  });
  it("retains an exact CPU baseline candidate without version tags or injected metadata", () => {
    const { report } = certificationArtifactFixture();
    const candidate = {
      version: 1,
      id: `forecast-canary-v10-${report.canaryId}`,
      sourceCanaryId: report.canaryId,
      deploymentSha: PINNED_SHA,
      sampleHash: report.performance.sampleHash,
      collectorScriptVersion: "private-tag",
      dispatcherScriptVersion: "private-tag",
      collector: report.performance.collector,
      dispatcher: report.performance.dispatcher,
      ...privateMetadata,
    };
    const artifact = sanitizedBaselineCandidate(candidate, report);
    assertArtifactPrivacy(artifact);
    expect(artifact.data.collector.full.p95Ms).toBe(3);
    expect(artifact.data.collector.secondHalf.p95Ms).toBe(3);
    expect(artifact.data.sampleHash).toBe(report.performance.sampleHash);
    expect(artifact.projectionHash).toBe(hashEvidence(artifact.data));
    expect(() =>
      sanitizedBaselineCandidate(
        {
          ...candidate,
          collector: { ...candidate.collector, full: { ...candidate.collector.full, p95Ms: 30 } },
        },
        report,
      ),
    ).toThrow("forecast_retained_baseline_metrics_mismatch");
  });
});

describe("Privacy-safe Paid quota and burn-in artifact projections", () => {
  it("retains the specific missing-database diagnosis without the database identifier", () => {
    const { report } = certificationArtifactFixture();
    const databaseId = D1_DATABASE_IDS.forecastProduction;
    const errorCode = `cloudflare_paid_quota_required_database_missing:${databaseId}`;
    const artifact = sanitizedCertificationEvidence({
      ...report,
      evidence: { status: "incomplete", errors: [errorCode] },
      certification: { status: "incomplete", hardFailures: [], warnings: [] },
      quotaEvidence: {
        ...report.quotaEvidence,
        valid: false,
        errorCode,
        evidence: null,
        freshnessMinutes: null,
        policy: null,
        accountRuntime: null,
      },
    });
    expect(JSON.stringify(artifact)).not.toContain(databaseId);
    expect(artifact.data.evidence.errors).toEqual([
      `cloudflare_paid_quota_required_database_missing:database_hash_${hashEvidence(databaseId)}`,
    ]);
    expect(artifact.data.quotaEvidence.errorCode).toBe(artifact.data.evidence.errors[0]);
    expect(artifact.data.certification.status).toBe("incomplete");
    expect(artifact.data.performance.collector.full.p99Ms).toBe(4);
  });
  it("retains verified limits, totals, runtime CPU, daily baseline and thresholds without account identifiers", () => {
    const { snapshot, evaluation } = quotaArtifactFixture();
    const quota = sanitizedQuotaEvaluation({ ...evaluation, ...privateMetadata });
    const baseline = sanitizedQuotaBaseline(snapshot);
    assertArtifactPrivacy(quota);
    assertArtifactPrivacy(baseline);
    expect(quota.data.passed).toBe(evaluation.passed);
    expect(quota.data.metrics).toEqual(evaluation.metrics);
    expect(quota.data.evidence?.usage).toEqual(evaluation.evidence?.usage);
    expect(quota.data.evidence?.limits).toEqual(evaluation.evidence?.limits);
    expect(quota.data.evidence?.thresholds.hardStopPercent).toBe(50);
    expect(quota.data.evidence?.workerRuntime.startedAt).toBe(artifactWindow.startedAt);
    expect(quota.data.evidence?.workerRuntime.workers[0]?.cpuTimeP99Ms).toBe(4);
    expect(baseline.data.daily).toEqual([
      {
        date: "2026-10-01",
        workerRequests: 120,
        workerCpuMs: 240,
        d1RowsRead: 7,
        d1RowsWritten: 7,
      },
    ]);
    expect(baseline.sourceHash).toBe(hashEvidence(snapshot));
    expect(JSON.stringify(baseline)).not.toContain(snapshot.accountId);
    expect(baseline.projectionHash).toBe(hashEvidence(baseline.data));
  });
});

describe("Wrangler 4 forecast deployment evidence", () => {
  const deployment = {
    type: "deploy",
    version: 1,
    worker_name: "collection-kit-forecast-collector-staging",
    worker_tag: "a-service-tag-not-the-version-annotation",
    wrangler_environment: "staging",
    version_id: VERSION,
  };
  it("uses the typed deployment record, not incidental UUIDs or service tags", () => {
    const source = `${JSON.stringify({ type: "wrangler-session", version: 1 })}\n${JSON.stringify(deployment)}\n`;
    expect(deploymentVersionId(source, deployment.worker_name, "staging")).toBe(VERSION);
    expect(() => deploymentVersionId(source, "another-worker", "staging")).toThrow();
    expect(() => deploymentVersionId(source, deployment.worker_name, "")).toThrow();
    expect(() =>
      deploymentVersionId(
        `${source}${JSON.stringify(deployment)}\n`,
        deployment.worker_name,
        "staging",
      ),
    ).toThrow();
    expect(() =>
      deploymentVersionId(
        JSON.stringify({ ...deployment, version_id: "not-a-version" }),
        deployment.worker_name,
        "staging",
      ),
    ).toThrow();
  });
  it("accepts the explicit empty Wrangler environment for production", () => {
    const production = {
      ...deployment,
      worker_name: "collection-kit-forecast-collector",
      wrangler_environment: "",
    };
    expect(deploymentVersionId(JSON.stringify(production), production.worker_name, "")).toBe(
      VERSION,
    );
    expect(() =>
      deploymentVersionId(JSON.stringify(production), production.worker_name, "staging"),
    ).toThrow();
  });
  it("rejects missing, mixed and malformed prior deployments", () => {
    expect(activeVersionId({ versions: [{ version_id: VERSION, percentage: 100 }] })).toBe(VERSION);
    for (const versions of [
      [],
      [{ version_id: VERSION, percentage: 50 }],
      [
        { version_id: VERSION, percentage: 100 },
        { version_id: PINNED_SHA, percentage: 0 },
      ],
      [{ version_id: "", percentage: 100 }],
      [{ version_id: VERSION, percentage: "100" }],
    ])
      expect(() => activeVersionId({ versions })).toThrow();
  });
  it("binds sanitized rollout identity to the active version and plain-text SHA", () => {
    const value = {
      id: VERSION,
      annotations: { "workers/tag": `${PINNED_SHA}-enabled` },
      resources: {
        bindings: [
          { type: "plain_text", name: "DEPLOY_SHA", text: PINNED_SHA },
          { type: "plain_text", name: "DISPATCH_ENABLED", text: "true" },
          { type: "secret_text", name: "ADMIN_TOKEN", text: "never-return-this" },
        ],
      },
    };
    expect(workerVersionIdentity(value, VERSION)).toEqual({
      versionId: VERSION,
      deploymentSha: PINNED_SHA,
      tag: `${PINNED_SHA}-enabled`,
      vars: { DEPLOY_SHA: PINNED_SHA, DISPATCH_ENABLED: "true" },
    });
    expect(() => workerVersionIdentity({ ...value, id: "another-version" }, VERSION)).toThrow();
    expect(() =>
      workerVersionIdentity({ ...value, resources: { bindings: [] } }, VERSION),
    ).toThrow();
    expect(() =>
      workerVersionIdentity(
        {
          ...value,
          resources: { bindings: [{ type: "secret_text", name: "DEPLOY_SHA", text: PINNED_SHA }] },
        },
        VERSION,
      ),
    ).toThrow();
    expect(() =>
      workerVersionIdentity(
        {
          ...value,
          resources: { bindings: [value.resources.bindings[0], value.resources.bindings[0]] },
        },
        VERSION,
      ),
    ).toThrow();
  });
});

describe("Retained forecast identity evidence", () => {
  const canary = {
    deploymentSha: PINNED_SHA,
    canaryId: `fc-${"a".repeat(32)}`,
    collectorVersionId: VERSION,
    dispatcherVersionId: "87654321-1234-1234-1234-123456789abc",
    pollMode: "both",
    startedAt: "2026-10-01T00:00:00.000Z",
    endsAt: "2026-10-01T08:00:00.000Z",
  };
  const privateFields = {
    author_email: "operator@example.test",
    command_line_args: ["--var", "DISCORD_APPLICATION_ID:123456789"],
    vars: { DISCORD_GUILD_ID: "123456789", DISCORD_CHANNEL_ID: "987654321" },
    tag: "untrusted-annotation",
  };
  it("retains only the Worker version ID and SHA, never raw metadata or plain variables", () => {
    expect(
      sanitizedWorkerIdentity({
        versionId: VERSION,
        deploymentSha: PINNED_SHA,
        ...privateFields,
      }),
    ).toEqual({ versionId: VERSION, deploymentSha: PINNED_SHA });
    expect(() => sanitizedWorkerIdentity({ versionId: "", deploymentSha: PINNED_SHA })).toThrow();
  });
  it("retains readiness facts without copying arbitrary status text or metadata", () => {
    expect(
      sanitizedReadiness({
        deploymentSha: PINNED_SHA,
        status: "ok",
        productionMutationsEnabled: true,
        ...privateFields,
      }),
    ).toEqual({ deploymentSha: PINNED_SHA, healthOk: true, productionMutationsEnabled: true });
    expect(
      sanitizedReadiness({
        deploymentSha: PINNED_SHA,
        status: "arbitrary-private-message",
        ...privateFields,
      }),
    ).toEqual({ deploymentSha: PINNED_SHA, healthOk: false });
  });
  it("retains only the normalized canary IDs, versions, poll mode and immutable window", () => {
    expect(sanitizedCanaryIdentity({ ...canary, ...privateFields })).toEqual(canary);
    expect(() => sanitizedCanaryIdentity({ ...canary, collectorVersionId: "" })).toThrow();
  });
  it("renders the exact certified SHA and all canary and production version identities", () => {
    const productionVersions = {
      collector: VERSION,
      dispatcher: canary.dispatcherVersionId,
      router: "abcdef12-1234-1234-1234-123456789abc",
    };
    const summary = renderForecastIdentitySummary({
      ...canary,
      productionVersions,
      triggeringSha: "b".repeat(40),
      ...privateFields,
    });
    expect(summary).toBe(
      [
        "### Forecast Canary v10 verified identity",
        `- Certified deployment SHA: \`${PINNED_SHA}\``,
        `- Canary ID: \`${canary.canaryId}\``,
        `- Canary collector version: \`${VERSION}\``,
        `- Canary dispatcher version: \`${canary.dispatcherVersionId}\``,
        "- Poll mode: `both`",
        "- Window start: `2026-10-01T00:00:00.000Z`",
        "- Window end: `2026-10-01T08:00:00.000Z`",
        `- Production collector version: \`${VERSION}\``,
        `- Production dispatcher version: \`${canary.dispatcherVersionId}\``,
        `- Production router version: \`${productionVersions.router}\``,
        "",
      ].join("\n"),
    );
  });
  it("requires a Router HTTPS origin even when a fresh canary was not requested", () => {
    expect(() => assertRouterOrigin("https://router.example.test")).not.toThrow();
    for (const origin of ["", "http://router.example.test", "https://router.example.test/path"])
      expect(() => assertRouterOrigin(origin)).toThrow("FORECAST_INTERACTIONS_URL");
  });
});

describe("Forecast certification approval summary", () => {
  const report = {
    deploymentSha: PINNED_SHA,
    canaryId: `fc-${"a".repeat(32)}`,
    pollMode: "both",
    identity: {
      collectorScriptVersionId: VERSION,
      dispatcherScriptVersionId: "87654321-1234-1234-1234-123456789abc",
    },
    window: {
      startedAt: "2026-10-01T00:00:00.000Z",
      endsAt: "2026-10-01T08:00:00.000Z",
    },
    certification: {
      status: "passed_with_warning",
      warnings: ["baseline_bootstrap", "CPU < 5 & > 1", "<script>\n`override`"],
    },
    evidence: { status: "valid" },
    performance: {
      collector: { full: { p95Ms: 1.25, p99Ms: 2.5, maxMs: 3.75 } },
      dispatcher: { full: { p95Ms: 4.5, p99Ms: 6.25, maxMs: 9.5 } },
    },
    author_email: "excluded@example.test",
  };

  it("renders exact Korean approval information together with certified identities and window", () => {
    expect(renderForecastCertificationSummary(report)).toBe(
      [
        "# Forecast Canary v10 인증서",
        "",
        "- 상태: `passed_with_warning`",
        `- Canary ID: \`fc-${"a".repeat(32)}\``,
        `- 배포 SHA: \`${PINNED_SHA}\``,
        `- Collector 버전 ID: \`${VERSION}\``,
        "- Dispatcher 버전 ID: `87654321-1234-1234-1234-123456789abc`",
        "- Poll mode: `both`",
        "- Canary 시작: `2026-10-01T00:00:00.000Z`",
        "- Canary 종료: `2026-10-01T08:00:00.000Z`",
        "- 증거 상태: `valid`",
        "- Collector CPU p95/p99/max: 1.25 / 2.5 / 3.75 ms",
        "- Dispatcher CPU p95/p99/max: 4.5 / 6.25 / 9.5 ms",
        "- 경고: baseline\\_bootstrap, CPU &lt; 5 &amp; &gt; 1, &lt;script&gt; \\`override\\`",
        "",
      ].join("\n"),
    );
  });
  it("retains the no-warning indicator and rejects malformed approval metrics", () => {
    expect(
      renderForecastCertificationSummary({
        ...report,
        certification: { status: "passed", warnings: [] },
      }),
    ).toContain("- 경고: 없음");
    expect(() =>
      renderForecastCertificationSummary({
        ...report,
        performance: { ...report.performance, collector: { full: { p95Ms: "1" } } },
      }),
    ).toThrow("forecast_certification_summary_invalid");
  });
});

describe("validateWorkflowSource", () => {
  it("accepts pinned external actions, local actions, and bounded jobs", () => {
    const source = `jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@${PINNED_SHA} # v7
      - uses: ./local-action
`;

    expect(validateWorkflowSource(source)).toEqual([]);
  });

  it("rejects floating external action references", () => {
    const source = `jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
`;

    expect(validateWorkflowSource(source)).toEqual([
      {
        line: 6,
        message: 'external action "actions/checkout@v7" must use a full 40-character commit SHA',
      },
    ]);
  });

  it("rejects runnable jobs without a timeout", () => {
    const source = `jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;

    expect(validateWorkflowSource(source)).toEqual([
      { line: 2, message: 'job "verify" is missing timeout-minutes' },
    ]);
  });

  it("requires immutable Docker digests", () => {
    const source = `jobs:
  container-check:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: docker://alpine:3.22
`;

    expect(validateWorkflowSource(source)).toEqual([
      {
        line: 6,
        message: 'external Docker action "docker://alpine:3.22" must use a sha256 digest',
      },
    ]);
  });

  it("rejects a step that merges run and uses after a lost list marker", () => {
    const source = `jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Summarize
        run: |
          echo done
          run: not-a-key-inside-the-script
          - markdown list inside the script

        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          fetch-depth: 1
      - run: npm test
`;

    expect(validateWorkflowSource(source)).toEqual([
      { line: 12, message: 'job "audit" has a step with both run and uses' },
    ]);
  });

  it("does not require unsupported timeouts on reusable workflow call jobs", () => {
    const source = `jobs:
  delegated:
    uses: ./.github/workflows/reusable.yml
`;

    expect(validateWorkflowSource(source)).toEqual([]);
  });
});
