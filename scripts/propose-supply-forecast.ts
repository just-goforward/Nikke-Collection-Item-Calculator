import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertForecastCandidateInvariants,
  supplyForecastCandidateEnvelopeSchema,
} from "../shared/supplyForecastCandidate.ts";
import { probeXAdvisory } from "./forecast-x-advisory.ts";
import { renderSupplyForecastProposal } from "./supply-forecast-proposal.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = resolve(root, "shared", "supplyForecasts.json");
const collectorUrl = requiredEnvironment("FORECAST_COLLECTOR_URL").replace(/\/$/, "");
const adminToken = requiredEnvironment("FORECAST_COLLECTOR_ADMIN_TOKEN");
const proposalOutput = requiredEnvironment("FORECAST_PROPOSAL_OUTPUT");
const githubOutput = process.env["GITHUB_OUTPUT"];

const response = await fetch(`${collectorUrl}/admin/candidates`, {
  headers: { authorization: `Bearer ${adminToken}`, accept: "application/json" },
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`Collector candidate request failed with ${response.status}.`);
const body: unknown = await response.json();
if (!isRecord(body) || !Array.isArray(body["candidates"])) {
  throw new Error("Collector returned an invalid candidate list.");
}
const first = body["candidates"][0];
if (first === undefined) {
  await writeOutputs({ has_candidate: "false" });
  console.log("No forecast candidate is pending.");
  process.exit(0);
}

const envelope = supplyForecastCandidateEnvelopeSchema.parse(first);
assertForecastCandidateInvariants(envelope.candidate);
const calculatedHash = createHash("sha256").update(stableJson(envelope.candidate)).digest("hex");
if (calculatedHash !== envelope.payloadHash) throw new Error("Forecast candidate hash mismatch.");
const xAdvisory = await probeXAdvisory(envelope.candidate);

const registry = parseRegistry(await readFile(registryPath, "utf8"));
const existing = registry.forecasts.find(
  (forecast) => forecast.id === envelope.candidate.forecastId,
);
if (existing) {
  throw new Error(`Forecast ID already exists in the registry: ${existing.id}`);
}
registry.approvedForecastId = envelope.candidate.forecastId;
registry.forecasts.push({
  id: envelope.candidate.forecastId,
  kind: "schedule",
  rulesVersion: envelope.candidate.rulesVersion,
  effectiveFrom: envelope.candidate.forecastId.slice("supply-".length, "supply-YYYY-MM-DD".length),
  sourceEvidence: envelope.candidate.sourceEvidence,
  profiles: envelope.candidate.profiles,
});
await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
await writeFile(
  proposalOutput,
  renderSupplyForecastProposal(envelope, xAdvisory, registry),
  "utf8",
);
const title =
  xAdvisory.status === "conflict"
    ? `[X 일정 충돌 검토] ${envelope.candidate.forecastId}`
    : `수급 Forecast 후보 ${envelope.candidate.forecastId}`;
await writeOutputs({
  has_candidate: "true",
  candidate_id: envelope.candidate.candidateId,
  forecast_id: envelope.candidate.forecastId,
  branch: `automation/supply-forecast/${envelope.candidate.candidateId}`,
  title,
  draft: String(xAdvisory.status === "conflict"),
});

async function writeOutputs(values: Record<string, string>) {
  if (!githubOutput) return;
  const content = Object.entries(values)
    .map(([key, value]) => `${key}=${value.replace(/[\r\n]/g, " ")}`)
    .join("\n");
  await appendFile(githubOutput, `${content}\n`, "utf8");
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
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

function parseRegistry(value: string): {
  version: 3;
  activeForecastId: string;
  stagingForecastId: string;
  approvedForecastId: string;
  forecasts: Array<{
    id: string;
    kind: "fixed" | "schedule";
    rulesVersion: string;
    effectiveFrom: string;
    sourceEvidence: unknown[];
    profiles: Array<{
      id: string;
      effectiveFrom: string;
      effectiveUntil: string | null;
      scheduleStatus: "confirmed" | "estimated";
      expectedGain: { blue: number; purple: number; yellow: number };
    }>;
  }>;
} {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    parsed["version"] !== 3 ||
    typeof parsed["stagingForecastId"] !== "string" ||
    !Array.isArray(parsed["forecasts"])
  ) {
    throw new Error("Supply forecast registry is not version 3.");
  }
  return parsed as ReturnType<typeof parseRegistry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
