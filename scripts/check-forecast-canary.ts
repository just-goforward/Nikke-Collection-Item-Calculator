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
  x_enabled: String(report.x.automationQualified),
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

function isCanaryReport(value: unknown): value is {
  deploymentSha: string;
  passed: boolean;
  window: { eligible: boolean };
  x: { automationQualified: boolean };
} {
  if (!isRecord(value) || typeof value["deploymentSha"] !== "string") return false;
  if (typeof value["passed"] !== "boolean") return false;
  const window = value["window"];
  const x = value["x"];
  return (
    isRecord(window) &&
    typeof window["eligible"] === "boolean" &&
    isRecord(x) &&
    typeof x["automationQualified"] === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
