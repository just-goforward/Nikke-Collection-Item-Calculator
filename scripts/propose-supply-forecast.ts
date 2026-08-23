import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertForecastCandidateInvariants,
  supplyForecastCandidateEnvelopeSchema,
} from "../shared/supplyForecastCandidate";

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
if (envelope.candidate.sourceStatus === "conflict") {
  throw new Error("A conflicting forecast candidate must not be proposed.");
}

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
await writeFile(proposalOutput, renderProposal(envelope), "utf8");
await writeOutputs({
  has_candidate: "true",
  candidate_id: envelope.candidate.candidateId,
  forecast_id: envelope.candidate.forecastId,
  branch: `automation/supply-forecast/${envelope.candidate.candidateId}`,
  title: `수급 Forecast 후보 ${envelope.candidate.forecastId}`,
});

function renderProposal(envelope: typeof supplyForecastCandidateEnvelopeSchema._zod.output) {
  const candidate = envelope.candidate;
  const active = registry.forecasts.find((forecast) => forecast.id === registry.activeForecastId);
  const activeGain = active?.profiles[0]?.expectedGain;
  const candidateGain = candidate.profiles[0]?.expectedGain;
  const xChecklist =
    candidate.sourceStatus === "x_unavailable"
      ? "- [ ] X `@NIKKE_kr` 공개 게시물을 관리자가 수동 확인했습니다."
      : "- [x] X 공개 게시물과 자동 교차 확인됐습니다.";
  const evidence = candidate.sourceEvidence
    .map((source) => `- [${source.source}](${source.url}): ${source.excerpt}`)
    .join("\n");
  const profileRows = candidate.profiles
    .map(
      (profile) =>
        `| ${profile.id} | ${profile.effectiveFrom} | ${profile.effectiveUntil ?? "open"} | ${profile.scheduleStatus} | ${profile.expectedGain.blue.toFixed(6)} | ${profile.expectedGain.purple.toFixed(6)} | ${profile.expectedGain.yellow.toFixed(6)} |`,
    )
    .join("\n");
  return (
    `## Forecast approval\n\n` +
    `이 PR은 후보를 **approved지만 inactive** 상태로 등록합니다. 제품의 \`activeForecastId\`는 H/p 연구와 별도 adoption PR이 통과할 때까지 변경하지 않습니다.\n\n` +
    `- Candidate: \`${candidate.candidateId}\`\n` +
    `- Payload SHA-256: \`${envelope.payloadHash}\`\n` +
    `- Source status: \`${candidate.sourceStatus}\`\n` +
    `- Schedule: \`${candidate.schedule.soloStart}\` - \`${candidate.schedule.soloEnd}\` (\`${candidate.schedule.status}\`)\n` +
    `- New-round cadence: \`${candidate.schedule.cadenceDays ?? "not derivable"}\` day(s)\n` +
    `- Rules: \`${candidate.rulesVersion}\`, \`${candidate.dispatchPolicyId}\`\n` +
    `- Active first-profile gain: \`${formatGain(activeGain)}\`\n` +
    `- Candidate first-profile gain: \`${formatGain(candidateGain)}\`\n\n` +
    `${xChecklist}\n- [ ] 일정, 05:00 KST 경계, 솔로 레이드 day-3 cutoff를 확인했습니다.\n- [ ] gain profile이 시간에 따라 비증가함을 확인했습니다.\n\n` +
    `### Sources\n\n${evidence}\n\n` +
    `### Profiles\n\n| Profile | From | Until | Status | Blue | Purple | Yellow |\n|---|---|---|---|---:|---:|---:|\n${profileRows}\n\n` +
    `### Warnings\n\n${candidate.warnings.map((warning) => `- ${warning}`).join("\n") || "- None"}\n`
  );
}

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

function formatGain(gain: { blue: number; purple: number; yellow: number } | undefined) {
  return gain
    ? `${gain.blue.toFixed(6)} / ${gain.purple.toFixed(6)} / ${gain.yellow.toFixed(6)}`
    : "n/a";
}

function parseRegistry(value: string): {
  version: 2;
  activeForecastId: string;
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
  if (!isRecord(parsed) || parsed["version"] !== 2 || !Array.isArray(parsed["forecasts"])) {
    throw new Error("Supply forecast registry is not version 2.");
  }
  return parsed as ReturnType<typeof parseRegistry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
