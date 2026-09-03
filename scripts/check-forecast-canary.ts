import { appendFile, readFile, writeFile } from "node:fs/promises";
import { assertD1QuotaEvidence, type D1QuotaEvidence } from "../shared/d1QuotaEvidence.ts";
import { FORECAST_CANARY_POLICY_ID } from "../shared/forecastCanaryRuntime.ts";

const baseUrl = requiredEnvironment("FORECAST_COLLECTOR_URL").replace(/\/$/, "");
const token = requiredEnvironment("FORECAST_COLLECTOR_ADMIN_TOKEN");
const requestedCanaryId = process.env["FORECAST_CANARY_ID"];
const quotaEvidence = await optionalJson("FORECAST_CANARY_QUOTA_EVIDENCE", extractQuotaEvidence);
const runtimeTelemetry = await optionalJson("FORECAST_CANARY_RUNTIME_EVIDENCE", (value) => value);
const runtimeBaseline = await optionalJson("FORECAST_CANARY_RUNTIME_BASELINE", (value) => value);
if ((quotaEvidence || runtimeTelemetry || runtimeBaseline) && !requestedCanaryId) {
  throw new Error("FORECAST_CANARY_ID is required with final evidence.");
}

const reportUrl = new URL(`${baseUrl}/admin/canary-report`);
if (requestedCanaryId) reportUrl.searchParams.set("canaryId", requestedCanaryId);
const report: unknown = await fetchCanaryReport(reportUrl, token, {
  canaryId: requestedCanaryId,
  quotaEvidence,
  runtimeTelemetry,
  runtimeBaseline,
});
if (!isCanaryReport(report)) throw new Error("Canary report schema is invalid.");
assertCertificationConsistency(report);
if (report.quotaEvidence.valid) assertD1QuotaEvidence(report.quotaEvidence.evidence);

const expectedEnd = new Date(
  Date.parse(report.window.startedAt) + 8 * 60 * 60 * 1_000,
).toISOString();
if (report.window.endsAt !== expectedEnd) {
  throw new Error("Canary report is not an exact fixed eight-hour window.");
}
const reportOutput = process.env["FORECAST_CANARY_REPORT_OUTPUT"];
if (reportOutput) await writeFile(reportOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const promotable =
  report.certification.status === "passed" || report.certification.status === "passed_with_warning";
await outputs({
  canary_status: report.certification.status,
  canary_promotable: String(promotable),
  canary_warning: report.certification.warnings.join(",") || "none",
  canary_evidence_status: report.evidence.status,
  canary_eligible: String(report.window.eligible),
  canary_early_failed: String(report.window.earlyFailure),
  poll_mode: report.pollMode,
  deployment_sha: report.deploymentSha,
  canary_id: report.canaryId,
  canary_quota_valid: String(report.quotaEvidence.valid),
  canary_quota_error: report.quotaEvidence.errorCode ?? "none",
});
console.log(JSON.stringify(report, null, 2));

async function optionalJson<T>(name: string, transform: (value: unknown) => T) {
  const path = process.env[name];
  if (!path) return null;
  return transform(JSON.parse(await readFile(path, "utf8")) as unknown);
}

async function outputs(values: Record<string, string>) {
  const path = process.env["GITHUB_OUTPUT"];
  if (!path) return;
  await appendFile(
    path,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value.replace(/[\r\n]/g, " ")}`)
      .join("\n")}\n`,
    "utf8",
  );
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function extractQuotaEvidence(value: unknown) {
  if (isRecord(value) && "evidence" in value) return assertD1QuotaEvidence(value["evidence"]);
  return assertD1QuotaEvidence(value);
}

async function fetchCanaryReport(
  reportUrl: URL,
  adminToken: string,
  evidence: {
    canaryId: string | undefined;
    quotaEvidence: D1QuotaEvidence | null;
    runtimeTelemetry: unknown;
    runtimeBaseline: unknown;
  },
) {
  const hasEvidence =
    evidence.quotaEvidence !== null ||
    evidence.runtimeTelemetry !== null ||
    evidence.runtimeBaseline !== null;
  const response = await fetch(reportUrl, {
    method: hasEvidence ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${adminToken}`,
      accept: "application/json",
      ...(hasEvidence ? { "content-type": "application/json" } : {}),
    },
    ...(hasEvidence
      ? {
          body: JSON.stringify({
            canaryId: evidence.canaryId,
            quotaEvidence: evidence.quotaEvidence,
            runtimeTelemetry: evidence.runtimeTelemetry,
            runtimeBaseline: evidence.runtimeBaseline,
          }),
        }
      : {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Canary report returned ${response.status}.`);
  return response.json();
}

type GateResult = {
  status: "passed" | "failed" | "incomplete";
  failureCodes: string[];
};

type CanaryReport = {
  version: 10;
  policyId: typeof FORECAST_CANARY_POLICY_ID;
  canaryId: string;
  deploymentSha: string;
  pollMode: "both" | "alternating" | "missing";
  identity: {
    canaryId: string;
    deploymentSha: string;
    collectorScriptVersion: string;
    dispatcherScriptVersion: string;
    collectorScriptVersionId: string;
    dispatcherScriptVersionId: string;
    startedAt: string;
    endedAt: string;
  };
  acceptance: {
    windowMode: "fixed_8_hours";
    windowHours: number;
    minimumDeliveryRate: 0.99;
    minimumCompletionRate: 0.99;
    maximumMissingSlots: 1;
  };
  window: { startedAt: string; endsAt: string; eligible: boolean; earlyFailure: boolean };
  collector: InvocationSummary;
  dispatcher: InvocationSummary & {
    duplicateDispatches: number;
    duplicateRuns: number;
    invalidStates: number;
    smokeCount: number;
    invalidSmoke: number;
    passed: boolean;
  };
  router: {
    routerTestCount: number;
    duplicateInteractions: number;
    maxInitialResponseMs: number;
    passed: boolean;
  };
  quotaEvidence: CanaryQuota;
  invariants: { totalInvalid: number };
  evidence: { status: "valid" | "incomplete"; errors: string[] };
  functional: GateResult;
  integrity: GateResult;
  quota: GateResult;
  runtimeSafety: GateResult;
  performance: {
    status: "pass" | "warning" | "regression" | "baseline_bootstrap";
    warnings: string[];
    regressionCodes: string[];
    sampleHash: string;
    collector: CpuPerformanceEvidence;
    dispatcher: CpuPerformanceEvidence;
  };
  certification: {
    status: "passed" | "passed_with_warning" | "failed" | "incomplete";
    hardFailures: string[];
    warnings: string[];
  };
};

type CanaryQuota =
  | {
      valid: true;
      errorCode: null;
      evidence: D1QuotaEvidence;
      evidenceHash: string;
      initialEvidenceHash: string;
      freshnessMinutes: number;
      policy: { passed: boolean; failureCodes: string[] };
      accountRuntime: { status: "passed" | "failed" | "incomplete"; failureCodes: string[] };
    }
  | {
      valid: false;
      errorCode: string;
      evidence: null;
      evidenceHash: string;
      initialEvidenceHash: string;
      freshnessMinutes: null;
      policy: null;
      accountRuntime: null;
    };

type InvocationSummary = {
  expectedSlots: number;
  observedSlots: number;
  missingSlots: number;
  deliveryRate: number;
  completed: number;
  abandoned: number;
  completionRate: number;
  duplicateInvocations: number;
  unexpectedInvocations: number;
  lateInvocations: number;
  latestStatus: string;
};

type CpuPerformanceEvidence = {
  scriptName: string;
  configuredLimitMs: number;
  expectedSlots: number;
  d1ObservedSlots: number;
  telemetryObservedSlots: number;
  missingTelemetrySlots: number;
  coverage: number;
  exceededCpu: number;
  unsuccessfulOutcomes: number;
  duplicateSlots: number;
  unmatchedTelemetrySlots: number;
  markerOnlyIdentities: number;
  versionIdOnlyIdentities: number;
  full: CpuDistribution;
  firstHalf: CpuDistribution;
  secondHalf: CpuDistribution;
  p99LimitRatio: number;
};

type CpuDistribution = {
  samples: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
};

function isCanaryReport(value: unknown): value is CanaryReport {
  if (!isCanaryReportHeader(value)) return false;
  if (!hasCanaryReportSections(value)) return false;
  if (!hasCanaryGates(value)) return false;
  if (!hasCanaryIdentity(value)) return false;
  const pollMode = String(value["pollMode"]);
  if (!["both", "alternating"].includes(pollMode)) return false;
  const identity = value["identity"] as Record<string, unknown>;
  const window = value["window"] as Record<string, unknown>;
  return (
    identity["startedAt"] === window["startedAt"] &&
    identity["endedAt"] === window["endsAt"] &&
    identity["collectorScriptVersion"] === `${value["deploymentSha"]}-${pollMode}-v10` &&
    identity["dispatcherScriptVersion"] === `${value["deploymentSha"]}-v10` &&
    isVersionId(identity["collectorScriptVersionId"]) &&
    isVersionId(identity["dispatcherScriptVersionId"])
  );
}

function isCanaryReportHeader(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value["version"] === 10 &&
    value["policyId"] === FORECAST_CANARY_POLICY_ID &&
    typeof value["deploymentSha"] === "string" &&
    /^[0-9a-f]{40}$/.test(value["deploymentSha"]) &&
    /^fc-[0-9a-f]{32}$/.test(String(value["canaryId"]))
  );
}

function hasCanaryIdentity(value: Record<string, unknown>) {
  return (
    isRecord(value["identity"]) &&
    value["identity"]["canaryId"] === value["canaryId"] &&
    value["identity"]["deploymentSha"] === value["deploymentSha"]
  );
}

function hasCanaryReportSections(value: Record<string, unknown>) {
  return (
    isRecord(value["window"]) &&
    isAcceptancePolicy(value["acceptance"]) &&
    isCanaryWindow(value["window"]) &&
    isInvocationSummary(value["collector"]) &&
    isDispatcherSummary(value["dispatcher"]) &&
    isRouterSummary(value["router"]) &&
    isQuotaEvidence(value["quotaEvidence"]) &&
    hasInvariantSummary(value["invariants"]) &&
    isEvidence(value["evidence"]) &&
    isPerformance(value["performance"]) &&
    isCertification(value["certification"])
  );
}

function hasCanaryGates(value: Record<string, unknown>) {
  return ["functional", "integrity", "quota", "runtimeSafety"].every((key) =>
    isGateResult(value[key]),
  );
}

function hasInvariantSummary(value: unknown) {
  return isRecord(value) && typeof value["totalInvalid"] === "number";
}

function assertCertificationConsistency(report: CanaryReport) {
  const status = report.certification.status;
  const gates = [report.functional, report.integrity, report.quota, report.runtimeSafety];
  if (status === "failed" && report.certification.hardFailures.length === 0) {
    throw new Error("Failed canary has no hard failure evidence.");
  }
  if (
    (status === "passed" || status === "passed_with_warning") &&
    (!report.window.eligible ||
      report.evidence.status !== "valid" ||
      gates.some((gate) => gate.status !== "passed") ||
      report.certification.hardFailures.length > 0)
  )
    throw new Error("Promotable canary has inconsistent gate evidence.");
  if (status === "passed_with_warning" && report.certification.warnings.length === 0) {
    throw new Error("Warning canary has no warning evidence.");
  }
  if (status === "incomplete" && report.certification.hardFailures.length > 0) {
    throw new Error("Incomplete canary contains hard failure evidence.");
  }
}

function isQuotaEvidence(value: unknown): value is CanaryQuota {
  if (!isQuotaEvidenceHeader(value)) return false;
  return value["valid"] === true ? isValidQuotaEvidence(value) : isInvalidQuotaEvidence(value);
}

function isQuotaEvidenceHeader(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value["evidenceHash"] === "string" &&
    typeof value["initialEvidenceHash"] === "string"
  );
}

function isValidQuotaEvidence(value: Record<string, unknown>) {
  const policy = value["policy"];
  const runtime = value["accountRuntime"];
  return (
    value["valid"] === true &&
    value["errorCode"] === null &&
    typeof value["freshnessMinutes"] === "number" &&
    isRecord(value["evidence"]) &&
    isRecord(policy) &&
    typeof policy["passed"] === "boolean" &&
    isStringArray(policy["failureCodes"]) &&
    isRecord(runtime) &&
    ["passed", "failed", "incomplete"].includes(String(runtime["status"])) &&
    isStringArray(runtime["failureCodes"])
  );
}

function isInvalidQuotaEvidence(value: Record<string, unknown>) {
  return (
    value["valid"] === false &&
    typeof value["errorCode"] === "string" &&
    value["evidence"] === null &&
    value["freshnessMinutes"] === null &&
    value["policy"] === null &&
    value["accountRuntime"] === null
  );
}

function isCanaryWindow(value: Record<string, unknown>) {
  const startedAt = Date.parse(String(value["startedAt"]));
  const endsAt = Date.parse(String(value["endsAt"]));
  return (
    Number.isFinite(startedAt) &&
    Number.isFinite(endsAt) &&
    endsAt - startedAt === 8 * 60 * 60 * 1_000 &&
    typeof value["eligible"] === "boolean" &&
    typeof value["earlyFailure"] === "boolean"
  );
}

function isInvocationSummary(value: unknown) {
  if (!isRecord(value)) return false;
  return (
    [
      "expectedSlots",
      "observedSlots",
      "missingSlots",
      "deliveryRate",
      "completed",
      "abandoned",
      "completionRate",
      "duplicateInvocations",
      "unexpectedInvocations",
      "lateInvocations",
    ].every((key) => typeof value[key] === "number") && typeof value["latestStatus"] === "string"
  );
}

function isRouterSummary(value: unknown) {
  return (
    isRecord(value) &&
    typeof value["routerTestCount"] === "number" &&
    typeof value["duplicateInteractions"] === "number" &&
    typeof value["maxInitialResponseMs"] === "number" &&
    typeof value["passed"] === "boolean"
  );
}

function isDispatcherSummary(value: unknown) {
  return (
    isInvocationSummary(value) &&
    isRecord(value) &&
    ["duplicateDispatches", "duplicateRuns", "invalidStates", "smokeCount", "invalidSmoke"].every(
      (key) => typeof value[key] === "number",
    ) &&
    typeof value["passed"] === "boolean"
  );
}

function isAcceptancePolicy(value: unknown) {
  return (
    isRecord(value) &&
    value["windowMode"] === "fixed_8_hours" &&
    value["windowHours"] === 8 &&
    value["minimumDeliveryRate"] === 0.99 &&
    value["minimumCompletionRate"] === 0.99 &&
    value["maximumMissingSlots"] === 1
  );
}

function isEvidence(value: unknown) {
  return (
    isRecord(value) &&
    ["valid", "incomplete"].includes(String(value["status"])) &&
    isStringArray(value["errors"])
  );
}

function isGateResult(value: unknown): value is GateResult {
  return (
    isRecord(value) &&
    ["passed", "failed", "incomplete"].includes(String(value["status"])) &&
    isStringArray(value["failureCodes"])
  );
}

function isPerformance(value: unknown) {
  return (
    isRecord(value) &&
    ["pass", "warning", "regression", "baseline_bootstrap"].includes(String(value["status"])) &&
    isStringArray(value["warnings"]) &&
    isStringArray(value["regressionCodes"]) &&
    typeof value["sampleHash"] === "string" &&
    /^[0-9a-f]{64}$/.test(value["sampleHash"]) &&
    isCpuPerformanceEvidence(value["collector"]) &&
    isCpuPerformanceEvidence(value["dispatcher"])
  );
}

function isCpuPerformanceEvidence(value: unknown): value is CpuPerformanceEvidence {
  if (!isRecord(value)) return false;
  const numeric = [
    "configuredLimitMs",
    "expectedSlots",
    "d1ObservedSlots",
    "telemetryObservedSlots",
    "missingTelemetrySlots",
    "coverage",
    "exceededCpu",
    "unsuccessfulOutcomes",
    "duplicateSlots",
    "unmatchedTelemetrySlots",
    "markerOnlyIdentities",
    "versionIdOnlyIdentities",
    "p99LimitRatio",
  ];
  return (
    typeof value["scriptName"] === "string" &&
    numeric.every((key) => typeof value[key] === "number" && Number.isFinite(value[key])) &&
    isCpuDistribution(value["full"]) &&
    isCpuDistribution(value["firstHalf"]) &&
    isCpuDistribution(value["secondHalf"])
  );
}

function isCpuDistribution(value: unknown): value is CpuDistribution {
  return (
    isRecord(value) &&
    ["samples", "averageMs", "p50Ms", "p95Ms", "p99Ms", "maxMs"].every(
      (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
    )
  );
}

function isCertification(value: unknown): value is CanaryReport["certification"] {
  return (
    isRecord(value) &&
    ["passed", "passed_with_warning", "failed", "incomplete"].includes(String(value["status"])) &&
    isStringArray(value["hardFailures"]) &&
    isStringArray(value["warnings"])
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isVersionId(value: unknown) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
