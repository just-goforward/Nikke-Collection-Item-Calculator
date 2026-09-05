import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readBoundedJson } from "../shared/boundedHttp.ts";

const DEFAULT_ATTEMPTS = 12;
const DEFAULT_DELAY_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const RESPONSE_LIMIT_BYTES = 128 * 1024;

type FetchApprovedAdoptionOptions = {
  collectorUrl: string;
  adminToken: string;
  attempts?: number;
  delayMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
};

export type ApprovedStagingAdoption = {
  approvalId: string;
  forecastId: string;
  sourcePullRequestNumber: number;
  sourceHeadSha: string;
  registrySha: string;
  researchRunId: number;
  researchArtifactName: string;
  researchArtifactDigest: string;
};

export async function fetchApprovedStagingAdoption({
  collectorUrl,
  adminToken,
  attempts = DEFAULT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
}: FetchApprovedAdoptionOptions): Promise<ApprovedStagingAdoption | null> {
  assertOptions(collectorUrl, adminToken, attempts, delayMs, requestTimeoutMs);
  const endpoint = `${collectorUrl.replace(/\/$/, "")}/admin/discord-staging-adoptions?limit=1`;
  let lastFailure = "unknown";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${adminToken}`,
          "Cache-Control": "no-cache",
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      lastFailure = error instanceof Error ? error.name : "network_error";
      if (attempt < attempts) {
        await sleep(delayMs);
        continue;
      }
      break;
    }

    if (response.status === 200) {
      const payload = await readBoundedJson(
        response,
        RESPONSE_LIMIT_BYTES,
        "staging_adoption_response_invalid",
      );
      return parseApprovedStagingAdoption(payload);
    }

    lastFailure = `HTTP ${response.status}`;
    await response.body?.cancel().catch(() => undefined);
    const retryable = response.status === 404 || response.status === 429 || response.status >= 500;
    if (!retryable) {
      throw new Error(`Staging adoption endpoint returned ${lastFailure}.`);
    }
    if (attempt < attempts) await sleep(delayMs);
  }

  throw new Error(
    `Staging adoption endpoint did not become ready after ${attempts} attempts (${lastFailure}).`,
  );
}

export function parseApprovedStagingAdoption(value: unknown): ApprovedStagingAdoption | null {
  if (!isRecord(value) || !Array.isArray(value["adoptions"])) {
    throw new Error("Invalid staging adoption response envelope.");
  }
  const row = value["adoptions"][0];
  if (row === undefined) return null;
  if (!isRecord(row)) throw new Error("Invalid approved staging adoption row.");

  const result = {
    approvalId: matchingString(row["approvalId"], /^discord-staging-[0-9a-f-]{36}$/),
    forecastId: matchingString(row["forecastId"], /^supply-\d{4}-\d{2}-\d{2}-v\d+$/),
    sourcePullRequestNumber: positiveInteger(row["sourcePullRequestNumber"]),
    sourceHeadSha: matchingString(row["sourceHeadSha"], /^[0-9a-f]{40}$/),
    registrySha: matchingString(row["registrySha"], /^[0-9a-f]{40}$/),
    researchRunId: positiveInteger(row["researchRunId"]),
    researchArtifactName: matchingString(
      row["researchArtifactName"],
      /^dynamic-hp-exact-gate-summary-[1-9][0-9]*$/,
    ),
    researchArtifactDigest: matchingString(row["researchArtifactDigest"], /^[0-9a-f]{64}$/),
  };
  if (Object.values(result).some((entry) => entry === null)) {
    throw new Error("Invalid approved staging adoption row.");
  }
  return result as ApprovedStagingAdoption;
}

function writeOutputs(adoption: ApprovedStagingAdoption | null) {
  const output = requiredEnvironment("GITHUB_OUTPUT");
  if (!adoption) {
    appendFileSync(output, "found=false\n");
    return;
  }
  const entries = {
    approval_id: adoption.approvalId,
    forecast_id: adoption.forecastId,
    source_pr: String(adoption.sourcePullRequestNumber),
    source_head_sha: adoption.sourceHeadSha,
    registry_sha: adoption.registrySha,
    research_run_id: String(adoption.researchRunId),
    research_artifact_name: adoption.researchArtifactName,
    research_artifact_digest: adoption.researchArtifactDigest,
  };
  for (const [key, value] of Object.entries(entries)) appendFileSync(output, `${key}=${value}\n`);
  appendFileSync(output, "found=true\n");
}

function assertOptions(
  collectorUrl: string,
  adminToken: string,
  attempts: number,
  delayMs: number,
  requestTimeoutMs: number,
) {
  if (!/^https:\/\//.test(collectorUrl) || adminToken.length === 0) {
    throw new Error("Staging collector configuration is missing.");
  }
  if (attempts < 1 || delayMs < 0 || requestTimeoutMs < 1) {
    throw new Error("Invalid staging adoption probe options.");
  }
}

function matchingString(value: unknown, pattern: RegExp) {
  return typeof value === "string" && !value.includes("\n") && pattern.test(value) ? value : null;
}

function positiveInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main() {
  writeOutputs(
    await fetchApprovedStagingAdoption({
      collectorUrl: requiredEnvironment("FORECAST_COLLECTOR_URL"),
      adminToken: requiredEnvironment("FORECAST_COLLECTOR_ADMIN_TOKEN"),
    }),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
