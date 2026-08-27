import { createHash } from "node:crypto";
import {
  assertForecastCandidateInvariants,
  supplyForecastCandidateEnvelopeSchema,
} from "../shared/supplyForecastCandidate.ts";

const baseUrl = requiredArgument(2).replace(/\/$/, "");
const token = requiredArgument(3);
const mode = process.argv[4] ?? "probe";
const expectedDeploySha = process.env["FORECAST_EXPECTED_DEPLOY_SHA"];

const health = await request("/health", false);
if (!isRecord(health) || health["status"] !== "ok")
  throw new Error("Invalid public health response.");
for (const forbidden of ["payload_json", "error_code", "excerpt", "token"]) {
  if (JSON.stringify(health).toLowerCase().includes(forbidden)) {
    throw new Error(`Public health leaked forbidden field: ${forbidden}`);
  }
}

if (expectedDeploySha) await waitForDeployment(expectedDeploySha);

if (mode === "health-only") {
  console.log("Forecast collector health smoke passed.");
  process.exit(0);
}

const probe = await request("/admin/probe", true, "POST");
if (!isRecord(probe) || !["completed", "circuit_open"].includes(String(probe["outcome"]))) {
  throw new Error("Collector probe did not return a typed successful outcome.");
}
const queue = await request("/admin/source-queue?limit=20", true);
if (!isRecord(queue) || !Array.isArray(queue["items"])) {
  throw new Error("Collector source queue response is invalid.");
}
const ledger = await request("/admin/schedule-ledger", true);
if (!isRecord(ledger) || !Array.isArray(ledger["events"])) {
  throw new Error("Collector schedule ledger response is invalid.");
}
const roundTrip = await request("/admin/source-queue/process", true, "POST", {
  mode: "bootstrap",
  results: [],
});
if (!isRecord(roundTrip) || roundTrip["processed"] !== 0) {
  throw new Error("Collector queue round-trip response is invalid.");
}
const compatibility = await request("/admin/candidates/supersede-incompatible", true, "POST");
if (!isRecord(compatibility) || !Number.isInteger(compatibility["superseded"])) {
  throw new Error("Collector candidate compatibility response is invalid.");
}
const pending = await request("/admin/candidates", true);
if (!isRecord(pending) || !Array.isArray(pending["candidates"])) {
  throw new Error("Collector candidate response is invalid.");
}
for (const raw of pending["candidates"]) {
  const envelope = supplyForecastCandidateEnvelopeSchema.parse(raw);
  assertForecastCandidateInvariants(envelope.candidate);
  const hash = createHash("sha256").update(stableJson(envelope.candidate)).digest("hex");
  if (hash !== envelope.payloadHash)
    throw new Error("Collector smoke found a candidate hash mismatch.");
}
console.log(
  `Forecast collector smoke passed with ${pending["candidates"].length} pending candidate(s).`,
);

async function request(path: string, authenticated: boolean, method = "GET", body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(authenticated
      ? {
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
        }
      : {}),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}.`);
  return response.json() as Promise<unknown>;
}

async function waitForDeployment(expectedSha: string) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const report = await request("/admin/canary-report", true);
    if (isRecord(report) && report["deploymentSha"] === expectedSha) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("Deployed collector SHA did not converge before the smoke timeout.");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredArgument(index: number) {
  const value = process.argv[index];
  if (!value) throw new Error(`Missing argument ${index - 1}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
