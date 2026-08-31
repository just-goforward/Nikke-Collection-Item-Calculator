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
  version: 4;
  deploymentSha: string;
  pollMode: "both" | "alternating" | "missing";
  passed: boolean;
  acceptance: { windowHours: 12; minimumScheduled: 200; minimumCompletionRate: 0.99 };
  window: { eligible: boolean; earlyFailure: boolean };
  invocations: { scheduled: number; completed: number; abandoned: number };
  dispatcher: {
    scheduled: number;
    completed: number;
    abandoned: number;
    duplicateDispatches: number;
    duplicateRuns: number;
    invalidStates: number;
    smokeCount: number;
    invalidSmoke: number;
    passed: boolean;
  };
};

function isCanaryReport(value: unknown): value is CanaryReport {
  if (!isRecord(value) || value["version"] !== 4 || typeof value["deploymentSha"] !== "string")
    return false;
  if (typeof value["passed"] !== "boolean") return false;
  if (!["both", "alternating", "missing"].includes(String(value["pollMode"]))) return false;
  return (
    isAcceptancePolicy(value["acceptance"]) &&
    isCanaryWindow(value["window"]) &&
    isInvocationSummary(value["invocations"]) &&
    isDispatcherSummary(value["dispatcher"])
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
    typeof value["scheduled"] === "number" &&
    typeof value["completed"] === "number" &&
    typeof value["abandoned"] === "number"
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
    value["windowHours"] === 12 &&
    value["minimumScheduled"] === 200 &&
    value["minimumCompletionRate"] === 0.99
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
