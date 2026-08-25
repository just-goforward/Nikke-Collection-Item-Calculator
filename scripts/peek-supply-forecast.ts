import { appendFile } from "node:fs/promises";

const baseUrl = requiredEnvironment("FORECAST_COLLECTOR_URL").replace(/\/$/, "");
const token = requiredEnvironment("FORECAST_COLLECTOR_ADMIN_TOKEN");
const response = await fetch(`${baseUrl}/admin/candidates`, {
  headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`Collector candidate request failed with ${response.status}.`);
const body: unknown = await response.json();
if (!isRecord(body) || !Array.isArray(body["candidates"]))
  throw new Error("Invalid candidate list.");
const hasCandidate = body["candidates"].length > 0;
const output = process.env["GITHUB_OUTPUT"];
if (output) await appendFile(output, `has_candidate=${hasCandidate}\n`);
console.log(hasCandidate ? "A candidate is ready." : "No candidate is ready.");

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
