import { appendFile } from "node:fs/promises";

const baseUrl = requiredEnvironment("FORECAST_COLLECTOR_URL").replace(/\/$/, "");
const token = requiredEnvironment("FORECAST_COLLECTOR_ADMIN_TOKEN");
const response = await fetch(`${baseUrl}/admin/canary-report`, {
  headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`Canary report returned ${response.status}.`);
const report: unknown = await response.json();
if (!isCanaryReport(report)) throw new Error("Canary report schema is invalid.");
await outputs({
  canary_passed: String(report.passed),
  canary_eligible: String(report.window.eligible),
  canary_early_failed: String(report.window.earlyFailure),
  poll_mode: report.pollMode,
  deployment_sha: report.deploymentSha,
});
console.log(JSON.stringify(report, null, 2));

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

type CanaryReport = {
  version: 5;
  deploymentSha: string;
  pollMode: "both" | "alternating" | "missing";
  passed: boolean;
  acceptance: {
    windowHours: 8;
    minimumDeliveryRate: 0.99;
    minimumCompletionRate: 0.99;
    maximumMissingSlots: 1;
  };
  window: { eligible: boolean; earlyFailure: boolean };
  collector: InvocationSummary;
  dispatcher: {
    expectedSlots: number;
    observedSlots: number;
    missingSlots: number;
    completed: number;
    abandoned: number;
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
  invariants: { totalInvalid: number };
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

function isCanaryReport(value: unknown): value is CanaryReport {
  if (!isRecord(value) || value["version"] !== 5 || typeof value["deploymentSha"] !== "string")
    return false;
  if (typeof value["passed"] !== "boolean") return false;
  if (!["both", "alternating", "missing"].includes(String(value["pollMode"]))) return false;
  return (
    isAcceptancePolicy(value["acceptance"]) &&
    isCanaryWindow(value["window"]) &&
    isInvocationSummary(value["collector"]) &&
    isDispatcherSummary(value["dispatcher"]) &&
    isRouterSummary(value["router"]) &&
    isRecord(value["invariants"]) &&
    typeof value["invariants"]["totalInvalid"] === "number"
  );
}

function isCanaryWindow(value: unknown) {
  return (
    isRecord(value) &&
    typeof value["eligible"] === "boolean" &&
    typeof value["earlyFailure"] === "boolean"
  );
}

function isInvocationSummary(value: unknown) {
  return (
    isRecord(value) &&
    typeof value["expectedSlots"] === "number" &&
    typeof value["observedSlots"] === "number" &&
    typeof value["missingSlots"] === "number" &&
    typeof value["deliveryRate"] === "number" &&
    typeof value["completed"] === "number" &&
    typeof value["abandoned"] === "number" &&
    typeof value["completionRate"] === "number" &&
    typeof value["duplicateInvocations"] === "number" &&
    typeof value["unexpectedInvocations"] === "number" &&
    typeof value["lateInvocations"] === "number" &&
    typeof value["latestStatus"] === "string"
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
  if (!isRecord(value)) return false;
  if (!isInvocationSummary(value)) return false;
  return (
    typeof value["duplicateDispatches"] === "number" &&
    typeof value["duplicateRuns"] === "number" &&
    typeof value["invalidStates"] === "number" &&
    typeof value["smokeCount"] === "number" &&
    typeof value["invalidSmoke"] === "number" &&
    typeof value["passed"] === "boolean"
  );
}

function isAcceptancePolicy(value: unknown) {
  return (
    isRecord(value) &&
    value["windowHours"] === 8 &&
    value["minimumDeliveryRate"] === 0.99 &&
    value["minimumCompletionRate"] === 0.99 &&
    value["maximumMissingSlots"] === 1
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
