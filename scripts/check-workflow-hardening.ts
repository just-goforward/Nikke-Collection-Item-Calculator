import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { stableJson } from "../forecast-collector/src/crypto.ts";
import { type D1UsageSnapshot, evaluateD1PreflightBudget } from "../shared/cloudflarePaidUsage.ts";
import { assertD1QuotaEvidence } from "../shared/d1QuotaEvidence.ts";
import { assertForecastRuntimeTelemetryEvidence } from "../shared/forecastCanaryRuntime.ts";

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;
const DOCKER_DIGEST = /^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/i;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Wrangler 4 deploy NDJSON: worker_tag is a service tag, not workers/tag. */
export function deploymentVersionId(source: string, worker: string, environment: string): string {
  const rows: unknown[] = source
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const deployments = rows.filter((row) => isRecord(row) && row["type"] === "deploy");
  const row = deployments[0];
  if (
    deployments.length !== 1 ||
    !isRecord(row) ||
    row["version"] !== 1 ||
    row["worker_name"] !== worker ||
    row["wrangler_environment"] !== environment ||
    typeof row["version_id"] !== "string" ||
    !VERSION_ID.test(row["version_id"])
  )
    throw new Error("forecast_deployment_output_invalid");
  return row["version_id"];
}

export function activeVersionId(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value["versions"]) || value["versions"].length !== 1)
    throw new Error("forecast_previous_deployment_not_single");
  const version: unknown = value["versions"][0];
  if (
    !isRecord(version) ||
    version["percentage"] !== 100 ||
    typeof version["version_id"] !== "string" ||
    !VERSION_ID.test(version["version_id"])
  )
    throw new Error("forecast_previous_deployment_invalid");
  return version["version_id"];
}

function rolloutVariables(bindings: readonly unknown[]) {
  const names = new Set([
    "DEPLOY_SHA",
    "ENVIRONMENT",
    "FORECAST_ENVIRONMENT",
    "POLL_MODE",
    "COLLECT_ENABLED",
    "DISPATCH_ENABLED",
    "DISCORD_INTERACTION_OWNER",
    "PRODUCTION_MUTATIONS_ENABLED",
  ]);
  const vars: Record<string, string> = {};
  for (const binding of bindings) {
    if (!isRecord(binding) || typeof binding["name"] !== "string" || !names.has(binding["name"]))
      continue;
    if (
      binding["type"] !== "plain_text" ||
      typeof binding["text"] !== "string" ||
      Object.hasOwn(vars, binding["name"])
    )
      throw new Error("forecast_version_binding_invalid");
    vars[binding["name"]] = binding["text"];
  }
  return vars;
}

/** Only non-secret rollout controls are returned for retained evidence. */
export function workerVersionIdentity(value: unknown, versionId: string) {
  if (!VERSION_ID.test(versionId) || !isRecord(value) || value["id"] !== versionId)
    throw new Error("forecast_version_identity_mismatch");
  const resources = value["resources"];
  const annotations = value["annotations"];
  if (
    !isRecord(resources) ||
    !Array.isArray(resources["bindings"]) ||
    !isRecord(annotations) ||
    typeof annotations["workers/tag"] !== "string" ||
    !annotations["workers/tag"]
  )
    throw new Error("forecast_version_identity_invalid");
  const vars = rolloutVariables(resources["bindings"] as unknown[]);
  const deploymentSha = vars["DEPLOY_SHA"];
  if (!deploymentSha || !/^[0-9a-f]{40}$/.test(deploymentSha))
    throw new Error("forecast_version_sha_invalid");
  return { versionId, deploymentSha, tag: annotations["workers/tag"], vars };
}

export function assertRouterOrigin(value: string) {
  if (!/^https:\/\/[^/]+$/.test(value))
    throw new Error(
      "Missing or invalid FORECAST_INTERACTIONS_URL; a production-owned Router HTTPS origin is required.",
    );
}

function evidenceRecord(value: unknown) {
  if (!isRecord(value)) throw new Error("forecast_identity_evidence_invalid");
  return value;
}

function evidenceString(value: Record<string, unknown>, key: string, pattern: RegExp) {
  const field = value[key];
  if (typeof field !== "string" || !pattern.test(field))
    throw new Error("forecast_identity_evidence_invalid");
  return field;
}

/** Artifact identity deliberately omits tags, plain-text variables and account metadata. */
export function sanitizedWorkerIdentity(value: unknown) {
  const record = evidenceRecord(value);
  return {
    versionId: evidenceString(record, "versionId", VERSION_ID),
    deploymentSha: evidenceString(record, "deploymentSha", /^[0-9a-f]{40}$/),
  };
}

export function sanitizedReadiness(value: unknown) {
  const record = evidenceRecord(value);
  return {
    deploymentSha: evidenceString(record, "deploymentSha", /^[0-9a-f]{40}$/),
    ...(Object.hasOwn(record, "status") ? { healthOk: record["status"] === "ok" } : {}),
    ...(typeof record["productionMutationsEnabled"] === "boolean"
      ? { productionMutationsEnabled: record["productionMutationsEnabled"] }
      : {}),
  };
}

export function sanitizedCanaryIdentity(value: unknown) {
  const record = evidenceRecord(value);
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  return {
    canaryId: evidenceString(record, "canaryId", /^fc-[0-9a-f]{32}$/),
    deploymentSha: evidenceString(record, "deploymentSha", /^[0-9a-f]{40}$/),
    collectorVersionId: evidenceString(record, "collectorVersionId", VERSION_ID),
    dispatcherVersionId: evidenceString(record, "dispatcherVersionId", VERSION_ID),
    pollMode: evidenceString(record, "pollMode", /^(both|alternating)$/),
    startedAt: evidenceString(record, "startedAt", timestamp),
    endsAt: evidenceString(record, "endsAt", timestamp),
  };
}

function productionVersionSummary(value: unknown) {
  const record = evidenceRecord(value);
  return ["collector", "dispatcher", "router"].map(
    (component) =>
      `- Production ${component} version: \`${evidenceString(record, component, VERSION_ID)}\``,
  );
}

export function renderForecastIdentitySummary(value: unknown) {
  const identity = sanitizedCanaryIdentity(value);
  const record = evidenceRecord(value);
  return [
    "### Forecast Canary v10 verified identity",
    `- Certified deployment SHA: \`${identity.deploymentSha}\``,
    `- Canary ID: \`${identity.canaryId}\``,
    `- Canary collector version: \`${identity.collectorVersionId}\``,
    `- Canary dispatcher version: \`${identity.dispatcherVersionId}\``,
    `- Poll mode: \`${identity.pollMode}\``,
    `- Window start: \`${identity.startedAt}\``,
    `- Window end: \`${identity.endsAt}\``,
    ...(record["productionVersions"] === undefined
      ? []
      : productionVersionSummary(record["productionVersions"])),
    "",
  ].join("\n");
}

function certificationIdentity(record: Record<string, unknown>) {
  const identity = evidenceRecord(record["identity"]);
  const window = evidenceRecord(record["window"]);
  return sanitizedCanaryIdentity({
    canaryId: record["canaryId"],
    deploymentSha: record["deploymentSha"],
    pollMode: record["pollMode"],
    collectorVersionId: identity["collectorScriptVersionId"],
    dispatcherVersionId: identity["dispatcherScriptVersionId"],
    startedAt: window["startedAt"],
    endsAt: window["endsAt"],
  });
}

function certificationCpuSummary(value: unknown) {
  const record = evidenceRecord(value);
  const metrics = ["p95Ms", "p99Ms", "maxMs"].map((key) => {
    const metric = record[key];
    if (typeof metric !== "number" || !Number.isFinite(metric))
      throw new Error("forecast_certification_summary_invalid");
    return metric;
  });
  return `${metrics.join(" / ")} ms`;
}

function certificationWarning(value: unknown) {
  if (typeof value !== "string") throw new Error("forecast_certification_summary_invalid");
  const escapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\\": "\\\\",
    "`": "\\`",
    "*": "\\*",
    _: "\\_",
    "[": "\\[",
    "]": "\\]",
    "(": "\\(",
    ")": "\\)",
    "|": "\\|",
  };
  return Array.from(value)
    .map((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ? " "
        : (escapes[character] ?? character),
    )
    .join("");
}

export function renderForecastCertificationSummary(value: unknown) {
  const record = evidenceRecord(value);
  const identity = certificationIdentity(record);
  const certification = evidenceRecord(record["certification"]);
  const evidence = evidenceRecord(record["evidence"]);
  const performance = evidenceRecord(record["performance"]);
  const collector = evidenceRecord(performance["collector"]);
  const dispatcher = evidenceRecord(performance["dispatcher"]);
  const warnings = certification["warnings"];
  if (!Array.isArray(warnings)) throw new Error("forecast_certification_summary_invalid");
  return [
    "# Forecast Canary v10 인증서",
    "",
    `- 상태: \`${evidenceString(certification, "status", /^(passed|passed_with_warning|failed|incomplete)$/)}\``,
    `- Canary ID: \`${identity.canaryId}\``,
    `- 배포 SHA: \`${identity.deploymentSha}\``,
    `- Collector 버전 ID: \`${identity.collectorVersionId}\``,
    `- Dispatcher 버전 ID: \`${identity.dispatcherVersionId}\``,
    `- Poll mode: \`${identity.pollMode}\``,
    `- Canary 시작: \`${identity.startedAt}\``,
    `- Canary 종료: \`${identity.endsAt}\``,
    `- 증거 상태: \`${evidenceString(evidence, "status", /^(valid|incomplete)$/)}\``,
    `- Collector CPU p95/p99/max: ${certificationCpuSummary(collector["full"])}`,
    `- Dispatcher CPU p95/p99/max: ${certificationCpuSummary(dispatcher["full"])}`,
    `- 경고: ${warnings.length === 0 ? "없음" : warnings.map(certificationWarning).join(", ")}`,
    "",
  ].join("\n");
}

const evidenceNumber = z.number().nonnegative();
const evidenceTimestamp = z.iso.datetime();
const evidenceHash = z.string().regex(/^[0-9a-f]{64}$/);
const publicWorkerNames = [
  "collection-kit-stats",
  "collection-kit-stats-staging",
  "collection-kit-forecast-collector",
  "collection-kit-forecast-collector-staging",
  "collection-kit-forecast-dispatcher",
  "collection-kit-forecast-dispatcher-staging",
  "collection-kit-forecast-interactions",
  "collection-kit-usage-guard",
] as const;
const evidenceCode = z.union([
  z
    .string()
    .regex(new RegExp(`^[a-z][a-z0-9_]*(?::(?:[a-z][a-z0-9_]*|${publicWorkerNames.join("|")}))*$`)),
  z
    .string()
    .regex(
      /^cloudflare_paid_quota_required_database_missing:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    .transform(
      (code) =>
        `cloudflare_paid_quota_required_database_missing:database_hash_${canonicalEvidenceHash(code.split(":")[1])}`,
    ),
]);
const evidenceCodes = z.array(evidenceCode);
const gateSchema = z.object({
  status: z.enum(["passed", "failed", "incomplete"]),
  failureCodes: evidenceCodes,
});
const distributionSchema = z.object({
  samples: evidenceNumber,
  averageMs: evidenceNumber,
  p50Ms: evidenceNumber,
  p95Ms: evidenceNumber,
  p99Ms: evidenceNumber,
  maxMs: evidenceNumber,
});
const performanceWorkerSchema = z.object({
  configuredLimitMs: evidenceNumber,
  expectedSlots: evidenceNumber,
  d1ObservedSlots: evidenceNumber,
  telemetryObservedSlots: evidenceNumber,
  missingTelemetrySlots: evidenceNumber,
  coverage: evidenceNumber,
  runtimeObservedSlots: evidenceNumber.optional(),
  missingRuntimeSlots: evidenceNumber.optional(),
  runtimeCoverage: evidenceNumber.optional(),
  exceededCpu: evidenceNumber,
  unsuccessfulOutcomes: evidenceNumber,
  duplicateSlots: evidenceNumber,
  unmatchedTelemetrySlots: evidenceNumber,
  markerOnlyIdentities: evidenceNumber,
  versionIdOnlyIdentities: evidenceNumber,
  full: distributionSchema,
  firstHalf: distributionSchema,
  secondHalf: distributionSchema,
  p99LimitRatio: evidenceNumber,
});
const invocationSchema = z.object({
  expectedSlots: evidenceNumber,
  observedSlots: evidenceNumber,
  missingSlots: evidenceNumber,
  deliveryRate: evidenceNumber,
  completed: evidenceNumber,
  abandoned: evidenceNumber,
  completionRate: evidenceNumber,
  duplicateInvocations: evidenceNumber,
  unexpectedInvocations: evidenceNumber,
  lateInvocations: evidenceNumber,
  latestStatus: z.enum(["missing", "running", "completed", "failure", "circuit_open"]),
});
const reportProjectionSchema = z.object({
  version: z.literal(10),
  policyId: z.literal("forecast-canary-v10-live-contract-v1"),
  acceptance: z.object({
    windowMode: z.literal("fixed_8_hours"),
    windowHours: z.literal(8),
    minimumDeliveryRate: z.literal(0.99),
    minimumCompletionRate: z.literal(0.99),
    maximumMissingSlots: z.literal(1),
  }),
  window: z.object({
    startedAt: evidenceTimestamp,
    endsAt: evidenceTimestamp,
    observedUntil: evidenceTimestamp.optional(),
    eligible: z.boolean(),
    earlyFailure: z.boolean(),
    earlyFailureReasons: evidenceCodes.optional(),
  }),
  collector: invocationSchema,
  dispatcher: invocationSchema.extend({
    duplicateDispatches: evidenceNumber,
    duplicateRuns: evidenceNumber,
    invalidStates: evidenceNumber,
    smokeCount: evidenceNumber,
    invalidSmoke: evidenceNumber,
    passed: z.boolean(),
  }),
  router: z.object({
    routerTestCount: evidenceNumber,
    duplicateInteractions: evidenceNumber,
    maxInitialResponseMs: evidenceNumber,
    failedAuthorizationSmoke: evidenceNumber.optional(),
    passed: z.boolean(),
  }),
  invariants: z.object({
    queue: evidenceNumber,
    cursors: evidenceNumber,
    candidates: evidenceNumber,
    watermarks: evidenceNumber,
    reviews: evidenceNumber,
    manualReviewCoverage: evidenceNumber,
    callbackStateConflicts: evidenceNumber,
    unsentCriticalAlerts: evidenceNumber,
    totalInvalid: evidenceNumber,
  }),
  evidence: z.object({ status: z.enum(["valid", "incomplete"]), errors: evidenceCodes }),
  functional: gateSchema,
  integrity: gateSchema,
  quota: gateSchema,
  runtimeSafety: gateSchema,
  performance: z.object({
    status: z.enum(["pass", "warning", "regression", "baseline_bootstrap"]),
    warnings: evidenceCodes,
    regressionCodes: evidenceCodes,
    sampleHash: evidenceHash,
    collector: performanceWorkerSchema,
    dispatcher: performanceWorkerSchema,
  }),
  certification: z.object({
    status: z.enum(["passed", "passed_with_warning", "failed", "incomplete"]),
    hardFailures: evidenceCodes,
    warnings: evidenceCodes,
  }),
});
const quotaResultSchema = z.object({
  valid: z.boolean(),
  errorCode: evidenceCode.nullable(),
  evidenceHash,
  initialEvidenceHash: evidenceHash,
  freshnessMinutes: evidenceNumber.nullable(),
  policy: z.object({ passed: z.boolean(), failureCodes: evidenceCodes }).nullable(),
  accountRuntime: gateSchema.nullable(),
});
const quotaWorkerSchema = z.object({
  requestsObserved: evidenceNumber,
  cpuMsObserved: evidenceNumber,
  errorsObserved: evidenceNumber,
  exceededCpuObserved: evidenceNumber,
  cpuTimeAverageMs: evidenceNumber,
  cpuTimeP95Ms: evidenceNumber,
  cpuTimeP99Ms: evidenceNumber,
});
const quotaEvaluationSchema = z.object({
  version: z.literal(2),
  passed: z.boolean(),
  action: z.enum([
    "normal",
    "warning",
    "disable_staging",
    "disable_forecast_production",
    "disable_statistics_writes",
    "hard_stop",
  ]),
  reasons: evidenceCodes,
  metrics: z.object({
    currentPercent: evidenceNumber,
    projectedPercent: evidenceNumber,
    governingMetric: z.enum([
      "workerRequests",
      "workerCpuMs",
      "d1RowsRead",
      "d1RowsWritten",
      "d1StorageBytes",
    ]),
    workerRequestsProjected: evidenceNumber,
    workerCpuMsProjected: evidenceNumber,
    d1RowsReadProjected: evidenceNumber,
    d1RowsWrittenProjected: evidenceNumber,
    d1StorageBytesProjected: evidenceNumber,
  }),
});

function canonicalEvidenceHash(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** Source hashes refer to originals, never to the privacy projection. */
function retainedEvidence<T>(kind: string, source: unknown, data: T) {
  return {
    version: 1,
    kind,
    sourceHash: canonicalEvidenceHash(source),
    projectionHash: canonicalEvidenceHash(data),
    data,
  };
}

function projectedQuota(value: unknown) {
  const evidence = assertD1QuotaEvidence(value);
  const { databases, workers, workerRuntime, ...totals } = evidence;
  return {
    ...totals,
    databaseCount: databases.length,
    workers: workers.map(projectedQuotaWorker),
    workerRuntime: {
      startedAt: workerRuntime.startedAt,
      endedAt: workerRuntime.endedAt,
      workers: workerRuntime.workers.map(projectedQuotaWorker),
    },
  };
}

function projectedQuotaWorker(value: unknown) {
  const record = evidenceRecord(value);
  const name = z.string().parse(record["scriptName"]);
  return {
    ...quotaWorkerSchema.parse(record),
    workerIdentityHash: canonicalEvidenceHash(name),
    projectWorker: publicWorkerNames.find((worker) => worker === name) ?? null,
  };
}

function projectedReportQuota(value: unknown) {
  const record = evidenceRecord(value);
  const result = quotaResultSchema.parse(record);
  if (!result.valid) return { ...result, evidence: null };
  const evidence = assertD1QuotaEvidence(record["evidence"]);
  if (canonicalEvidenceHash(evidence) !== result.evidenceHash)
    throw new Error("forecast_retained_quota_hash_mismatch");
  return { ...result, evidence: projectedQuota(evidence) };
}

export function sanitizedCertificationEvidence(value: unknown) {
  const record = evidenceRecord(value);
  const performance = evidenceRecord(record["performance"]);
  const baselineId = z.string().nullable().optional().parse(performance["baselineId"]);
  const projection = reportProjectionSchema.parse(record);
  const data = {
    ...projection,
    performance: {
      ...projection.performance,
      baselineIdentityHash: baselineId == null ? null : canonicalEvidenceHash(baselineId),
    },
    identity: certificationIdentity(record),
    quotaEvidence: projectedReportQuota(record["quotaEvidence"]),
  };
  return retainedEvidence("certification-projection", value, data);
}

const runtimeSampleProjectionSchema = z.object({
  slot: evidenceTimestamp,
  requestIdHash: evidenceHash,
  scriptVersionId: z.string().regex(VERSION_ID).nullable(),
  identitySource: z.enum(["tag", "version_id", "marker"]),
  eventType: z.literal("scheduled"),
  cpuTimeMs: evidenceNumber.nullable(),
  outcome: z
    .enum([
      "ok",
      "success",
      "exception",
      "exceededCpu",
      "exceededMemory",
      "canceled",
      "unknown",
      "responseStreamDisconnected",
      "scriptNotFound",
    ])
    .nullable(),
});

export function sanitizedRuntimeEvidence(value: unknown, report?: unknown) {
  const runtime = assertForecastRuntimeTelemetryEvidence(value);
  const sourceHash = canonicalEvidenceHash(value);
  if (report !== undefined) {
    const certificate = sanitizedCertificationEvidence(report);
    if (certificate.data.performance.sampleHash !== sourceHash)
      throw new Error("forecast_retained_runtime_hash_mismatch");
    const identity = certificate.data.identity;
    if (
      runtime.canaryId !== identity.canaryId ||
      runtime.deploymentSha !== identity.deploymentSha ||
      runtime.collectorScriptVersionId !== identity.collectorVersionId ||
      runtime.dispatcherScriptVersionId !== identity.dispatcherVersionId ||
      runtime.startedAt !== identity.startedAt ||
      runtime.endedAt !== identity.endsAt
    )
      throw new Error("forecast_retained_runtime_identity_mismatch");
  }
  const data = {
    version: runtime.version,
    source: runtime.source,
    canaryId: runtime.canaryId,
    deploymentSha: runtime.deploymentSha,
    collectorVersionId: runtime.collectorScriptVersionId,
    dispatcherVersionId: runtime.dispatcherScriptVersionId,
    startedAt: runtime.startedAt,
    endedAt: runtime.endedAt,
    observedAt: runtime.observedAt,
    collectionErrors: evidenceCodes.parse(runtime.collectionErrors ?? []),
    workers: runtime.workers.map((worker) => ({
      component: worker.component,
      configuredLimitMs: worker.configuredLimitMs,
      headSamplingRate: worker.headSamplingRate,
      samples: worker.samples.map((sample) => runtimeSampleProjectionSchema.parse(sample)),
    })),
  };
  return retainedEvidence("runtime-projection", value, data);
}

export function sanitizedQuotaEvaluation(value: unknown) {
  const record = evidenceRecord(value);
  const data = {
    ...quotaEvaluationSchema.parse(record),
    evidence: record["evidence"] === null ? null : projectedQuota(record["evidence"]),
  };
  return retainedEvidence("quota-evaluation-projection", value, data);
}

export function sanitizedQuotaBaseline(value: unknown) {
  const record = evidenceRecord(value);
  const evaluation = evaluateD1PreflightBudget(record as D1UsageSnapshot);
  const dailySchema = z.object({
    date: z.iso.date(),
    workerRequests: evidenceNumber,
    workerCpuMs: evidenceNumber,
    d1RowsRead: evidenceNumber,
    d1RowsWritten: evidenceNumber,
  });
  return retainedEvidence("quota-baseline-projection", value, {
    capturedAt: evidenceTimestamp.parse(record["capturedAt"]),
    daily: z.array(dailySchema).parse(record["daily"]),
    evaluation: sanitizedQuotaEvaluation(evaluation).data,
  });
}

export function sanitizedBaselineCandidate(value: unknown, report: unknown) {
  const record = evidenceRecord(value);
  const certificate = sanitizedCertificationEvidence(report);
  const identity = certificate.data.identity;
  const workerSchema = z.object({
    full: distributionSchema,
    firstHalf: distributionSchema,
    secondHalf: distributionSchema,
  });
  const schema = z.object({
    version: z.literal(1),
    id: z.literal(`forecast-canary-v10-${identity.canaryId}`),
    sourceCanaryId: z.literal(identity.canaryId),
    deploymentSha: z.literal(identity.deploymentSha),
    sampleHash: z.literal(certificate.data.performance.sampleHash),
    collector: workerSchema,
    dispatcher: workerSchema,
  });
  const data = schema.parse(record);
  for (const component of ["collector", "dispatcher"] as const) {
    const expected = workerSchema.parse(certificate.data.performance[component]);
    if (stableJson(data[component]) !== stableJson(expected))
      throw new Error("forecast_retained_baseline_metrics_mismatch");
  }
  return retainedEvidence("cpu-baseline-candidate-projection", value, data);
}

export type WorkflowHardeningIssue = {
  line: number;
  message: string;
};

type WorkflowJob = {
  id: string;
  line: number;
  hasTimeout: boolean;
  callsReusableWorkflow: boolean;
  environmentSource: string;
  environmentReported: boolean;
  step?: { keyIndent: number; keys: Set<string> } | undefined;
};

// A step that both runs a script and uses an action is rejected by GitHub as an invalid workflow,
// e.g. when a `- uses:` list marker is lost and the action merges into the preceding `run:` step.
function stepActionIssue(line: string, job: WorkflowJob): string | undefined {
  const start = line.match(/^( +)- +(?:(run|uses):)?/);
  const startIndent = start?.[1]?.length;
  // Deeper "- " lines belong to the current step's values, e.g. Markdown in a run block.
  if (startIndent !== undefined && startIndent >= 6 && startIndent < (job.step?.keyIndent ?? 99)) {
    job.step = { keyIndent: startIndent + 2, keys: new Set(start?.[2] ? [start[2]] : []) };
    return undefined;
  }
  const step = job.step;
  if (!step || line.trim() === "") return undefined;
  const indent = line.length - line.trimStart().length;
  if (indent < step.keyIndent) {
    job.step = undefined;
    return undefined;
  }
  const key = indent === step.keyIndent ? line.match(/^ +(run|uses):/)?.[1] : undefined;
  if (key === undefined) return undefined;
  step.keys.add(key);
  return step.keys.has("run") && step.keys.has("uses")
    ? `job "${job.id}" has a step with both run and uses`
    : undefined;
}

function jobEnvironmentIssue(line: string, job: WorkflowJob): string | undefined {
  if (line.trimStart().startsWith("#")) return undefined;
  if (/^ {4}\S/.test(line)) {
    job.environmentSource = /^ {4}env:/.test(line) ? line : "";
    job.environmentReported = false;
  } else if (job.environmentSource) {
    job.environmentSource += `\n${line}`;
  }
  if (!job.environmentReported && /\$\{\{[^}]*\brunner\s*\./.test(job.environmentSource)) {
    job.environmentReported = true;
    return `job "${job.id}" env cannot use runner context; move it to step-level env`;
  }
  return undefined;
}

function usesReference(line: string): string | undefined {
  const match = line.match(/^\s*(?:-\s+)?uses:\s*(.*?)\s*$/);
  if (!match) return undefined;

  const rawReference = match[1];
  if (rawReference === undefined) return undefined;

  let reference = rawReference.replace(/\s+#.*$/, "").trim();
  if (
    (reference.startsWith('"') && reference.endsWith('"')) ||
    (reference.startsWith("'") && reference.endsWith("'"))
  ) {
    reference = reference.slice(1, -1);
  }
  return reference;
}

function externalReferenceIssue(reference: string): string | undefined {
  if (reference.startsWith("./")) return undefined;
  if (reference.startsWith("docker://")) {
    if (!DOCKER_DIGEST.test(reference)) {
      return `external Docker action "${reference}" must use a sha256 digest`;
    }
    return undefined;
  }

  const separator = reference.lastIndexOf("@");
  const repository = separator >= 0 ? reference.slice(0, separator) : reference;
  const revision = separator >= 0 ? reference.slice(separator + 1) : "";
  if (!repository.includes("/") || !FULL_COMMIT_SHA.test(revision)) {
    return `external action "${reference}" must use a full 40-character commit SHA`;
  }
  return undefined;
}

export function validateWorkflowSource(source: string): WorkflowHardeningIssue[] {
  const issues: WorkflowHardeningIssue[] = [];
  const lines = source.split(/\r?\n/);
  let inJobs = false;
  let currentJob: WorkflowJob | undefined;

  const finishJob = () => {
    if (currentJob && !currentJob.hasTimeout && !currentJob.callsReusableWorkflow) {
      issues.push({
        line: currentJob.line,
        message: `job "${currentJob.id}" is missing timeout-minutes`,
      });
    }
    currentJob = undefined;
  };

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const reference = usesReference(line);
    if (reference !== undefined) {
      const message = externalReferenceIssue(reference);
      if (message) issues.push({ line: lineNumber, message });
    }

    if (/^jobs:\s*(?:#.*)?$/.test(line)) {
      finishJob();
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) {
      finishJob();
      inJobs = false;
      continue;
    }

    const jobMatch = line.match(/^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*(?:#.*)?$/);
    if (jobMatch) {
      const jobId = jobMatch[1];
      if (jobId === undefined) continue;

      finishJob();
      currentJob = {
        id: jobId,
        line: lineNumber,
        hasTimeout: false,
        callsReusableWorkflow: false,
        environmentSource: "",
        environmentReported: false,
      };
      continue;
    }
    if (!currentJob) continue;

    const stepIssue = stepActionIssue(line, currentJob);
    if (stepIssue) issues.push({ line: lineNumber, message: stepIssue });
    const environmentIssue = jobEnvironmentIssue(line, currentJob);
    if (environmentIssue) issues.push({ line: lineNumber, message: environmentIssue });
    if (/^ {4}timeout-minutes:\s*[^#\s]/.test(line)) currentJob.hasTimeout = true;
    if (/^ {4}uses:\s*[^#\s]/.test(line)) currentJob.callsReusableWorkflow = true;
  }

  finishJob();
  return issues.sort((left, right) => left.line - right.line);
}

function workflowFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return workflowFiles(path);
    return /\.ya?ml$/i.test(entry.name) ? [path] : [];
  });
}

function run() {
  const root = process.cwd();
  const files = workflowFiles(resolve(root, ".github/workflows")).sort();
  const failures = files.flatMap((file) =>
    validateWorkflowSource(readFileSync(file, "utf8")).map(
      (issue) => `${relative(root, file).replaceAll("\\", "/")}:${issue.line} ${issue.message}`,
    ),
  );

  if (failures.length > 0) {
    throw new Error(`Workflow hardening check failed:\n- ${failures.join("\n- ")}`);
  }
  console.log(`Workflow hardening check passed for ${files.length} workflow files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, file, workerOrVersion, environment] = process.argv.slice(2);
  if (mode === "--deployment-version" && file && workerOrVersion && environment !== undefined) {
    console.log(deploymentVersionId(readFileSync(file, "utf8"), workerOrVersion, environment));
  } else if (mode === "--active-version" && file) {
    console.log(activeVersionId(JSON.parse(readFileSync(file, "utf8"))));
  } else if (mode === "--version-identity" && file && workerOrVersion) {
    console.log(
      JSON.stringify(
        workerVersionIdentity(JSON.parse(readFileSync(file, "utf8")), workerOrVersion),
      ),
    );
  } else if (mode === "--router-origin" && file !== undefined) {
    assertRouterOrigin(file);
  } else if (mode === "--sanitize-identity" && file) {
    console.log(JSON.stringify(sanitizedWorkerIdentity(JSON.parse(readFileSync(file, "utf8")))));
  } else if (mode === "--sanitize-readiness" && file) {
    console.log(JSON.stringify(sanitizedReadiness(JSON.parse(readFileSync(file, "utf8")))));
  } else if (mode === "--sanitize-canary" && file) {
    console.log(JSON.stringify(sanitizedCanaryIdentity(JSON.parse(readFileSync(file, "utf8")))));
  } else if (mode === "--identity-summary" && file) {
    console.log(renderForecastIdentitySummary(JSON.parse(readFileSync(file, "utf8"))));
  } else if (mode === "--certification-summary" && file) {
    const report: unknown = JSON.parse(readFileSync(file, "utf8"));
    const certificate = sanitizedCertificationEvidence(report);
    console.log(
      renderForecastCertificationSummary({
        ...evidenceRecord(report),
        certification: certificate.data.certification,
      }),
    );
  } else if (mode === "--retain-evidence" && file && workerOrVersion) {
    const source: unknown = JSON.parse(readFileSync(file, "utf8"));
    const report: unknown = environment ? JSON.parse(readFileSync(environment, "utf8")) : undefined;
    const projections: Record<string, (value: unknown) => unknown> = {
      certification: sanitizedCertificationEvidence,
      runtime: (value) => sanitizedRuntimeEvidence(value, report),
      quota: sanitizedQuotaEvaluation,
      baseline: sanitizedQuotaBaseline,
      candidate: (value) => sanitizedBaselineCandidate(value, report),
    };
    const project = projections[workerOrVersion];
    if (!project) throw new Error("invalid_workflow_check_arguments");
    console.log(JSON.stringify(project(source)));
  } else if (mode === undefined) {
    run();
  } else {
    throw new Error("invalid_workflow_check_arguments");
  }
}
