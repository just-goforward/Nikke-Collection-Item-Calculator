import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { STAGING_FORECAST_REVIEW_URL } from "../shared/runtimeEnvironment";
import {
  type ForecastReviewMetadata,
  formatForecastReviewForDiscord,
  parseForecastReviewMetadata,
} from "./supply-forecast-proposal.ts";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const REPOSITORY = "just-goforward/Nikke-Collection-Item-Calculator";

type ResearchCertificate = {
  profileCount: number;
  evaluatedProfileCount: number;
  duplicateProfileCount: number;
  baselineCandidateId: "H0.75-p3";
  solverWasmSha256: string;
};

export type DiscordStagingAdoptionInput = {
  collectorUrl: string;
  collectorAdminToken: string;
  discordBotToken: string;
  discordChannelId: string;
  review: ForecastReviewMetadata;
  sourcePullRequestNumber: number;
  sourcePullRequestUrl: string;
  sourceHeadSha: string;
  registrySha: string;
  researchRunId: number;
  researchRunUrl: string;
  researchArtifactName: string;
  researchArtifactDigest: string;
  research: ResearchCertificate;
  runId: string;
  runAttempt: string;
};

type ApprovalRegistration = {
  approvalId: string;
  customId: string;
  forecastId: string;
  sourcePullRequestUrl: string;
  researchRunUrl: string;
  expiresAt: string;
  state: "pending" | "approved" | "adoption_pr_created" | "expired";
  discordChannelId: string | null;
  discordMessageId: string | null;
};

export async function sendDiscordStagingAdoption(
  input: DiscordStagingAdoptionInput,
  fetcher: typeof fetch = fetch,
) {
  validateInput(input);
  const payloadHash = sha256(
    JSON.stringify({
      forecastId: input.review.forecastId,
      sourcePullRequestNumber: input.sourcePullRequestNumber,
      sourceHeadSha: input.sourceHeadSha,
      researchRunId: input.researchRunId,
      researchArtifactName: input.researchArtifactName,
      researchArtifactDigest: input.researchArtifactDigest,
    }),
  );
  const requestKey = sha256(`${input.runId}:${input.runAttempt}:staging-adoption:${payloadHash}`);
  const registrationResponse = await fetcher(
    `${input.collectorUrl.replace(/\/$/, "")}/admin/discord-staging-adoptions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.collectorAdminToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        requestKey,
        forecastId: input.review.forecastId,
        payloadHash,
        sourcePullRequestNumber: input.sourcePullRequestNumber,
        sourcePullRequestUrl: input.sourcePullRequestUrl,
        sourceHeadSha: input.sourceHeadSha,
        registrySha: input.registrySha,
        researchRunId: input.researchRunId,
        researchRunUrl: input.researchRunUrl,
        researchArtifactName: input.researchArtifactName,
        researchArtifactDigest: input.researchArtifactDigest,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!registrationResponse.ok) {
    throw new Error(
      `Discord staging approval registration failed with ${registrationResponse.status}.`,
    );
  }
  const registration = parseRegistration(await registrationResponse.json());
  const messagePayload = buildDiscordStagingAdoptionMessage(registration, input);
  const message = await ensureDiscordStagingAdoptionMessage(
    input,
    registration,
    messagePayload,
    fetcher,
  );
  return { approvalId: registration.approvalId, payloadHash, ...message };
}

async function ensureDiscordStagingAdoptionMessage(
  input: DiscordStagingAdoptionInput,
  registration: ApprovalRegistration,
  messagePayload: ReturnType<typeof buildDiscordStagingAdoptionMessage>,
  fetcher: typeof fetch,
) {
  if (registration.state !== "pending") {
    return {
      messageId: registration.discordMessageId,
      reused: true,
    };
  }
  if (registration.discordMessageId) {
    return refreshDiscordStagingAdoptionMessage(input, registration, messagePayload, fetcher);
  }
  return createDiscordStagingAdoptionMessage(input, registration, messagePayload, fetcher);
}

async function refreshDiscordStagingAdoptionMessage(
  input: DiscordStagingAdoptionInput,
  registration: ApprovalRegistration,
  messagePayload: ReturnType<typeof buildDiscordStagingAdoptionMessage>,
  fetcher: typeof fetch,
) {
  if (registration.discordChannelId !== input.discordChannelId) {
    throw new Error("Discord staging approval channel identity changed.");
  }
  const editResponse = await fetcher(
    `${DISCORD_API_BASE}/channels/${input.discordChannelId}/messages/${registration.discordMessageId}`,
    {
      method: "PATCH",
      headers: discordJsonHeaders(input.discordBotToken),
      body: JSON.stringify(messagePayload),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!editResponse.ok) {
    throw new Error(`Discord staging approval message refresh failed with ${editResponse.status}.`);
  }
  return { messageId: registration.discordMessageId, reused: true };
}

async function createDiscordStagingAdoptionMessage(
  input: DiscordStagingAdoptionInput,
  registration: ApprovalRegistration,
  messagePayload: ReturnType<typeof buildDiscordStagingAdoptionMessage>,
  fetcher: typeof fetch,
) {
  const messageResponse = await fetcher(
    `${DISCORD_API_BASE}/channels/${input.discordChannelId}/messages`,
    {
      method: "POST",
      headers: discordJsonHeaders(input.discordBotToken),
      body: JSON.stringify(messagePayload),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!messageResponse.ok) {
    throw new Error(`Discord staging approval message failed with ${messageResponse.status}.`);
  }
  const message: unknown = await messageResponse.json();
  if (!isRecord(message) || typeof message["id"] !== "string") {
    throw new Error("Discord returned an invalid staging approval message response.");
  }
  const messageId = message["id"];
  const identityResponse = await fetcher(
    `${input.collectorUrl.replace(/\/$/, "")}/admin/discord-staging-adoptions/${registration.approvalId}/message`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.collectorAdminToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        discordChannelId: input.discordChannelId,
        discordMessageId: messageId,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!identityResponse.ok) {
    await fetcher(`${DISCORD_API_BASE}/channels/${input.discordChannelId}/messages/${messageId}`, {
      method: "DELETE",
      headers: { authorization: `Bot ${input.discordBotToken}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    throw new Error(
      `Discord staging approval message identity failed with ${identityResponse.status}.`,
    );
  }
  return {
    messageId,
    reused: false,
  };
}

function discordJsonHeaders(botToken: string) {
  return {
    authorization: `Bot ${botToken}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

export function buildDiscordStagingAdoptionMessage(
  registration: ApprovalRegistration,
  input: Pick<DiscordStagingAdoptionInput, "review" | "research">,
) {
  const schedule = formatForecastReviewForDiscord(input.review);
  return {
    content:
      "**Forecast staging 적용 승인 요청입니다.**\n" +
      `대상은 \`${input.review.forecastId}\`입니다.\n\n` +
      `${schedule.content}\n\n` +
      `H/p exact gate는 ${input.research.evaluatedProfileCount}개 고유 gain vector와 ` +
      `${input.research.profileCount}개 evidence profile에서 완료되었습니다. ` +
      `통과 기준은 \`${input.research.baselineCandidateId}\`입니다.\n` +
      `중복 evidence profile ${input.research.duplicateProfileCount}개는 인증서에서 alias로 보존되었습니다.\n\n` +
      "승인 시 staging adoption PR만 생성됩니다. PR 병합과 Pages 배포가 끝나면 " +
      `${STAGING_FORECAST_REVIEW_URL}에서 검증할 수 있습니다.\n` +
      "기본 URL의 production active forecast는 변경되지 않습니다.",
    allowed_mentions: { parse: [] },
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "staging 적용 승인",
            custom_id: registration.customId,
          },
          {
            type: 2,
            style: 5,
            label: "Forecast 원본 PR",
            url: registration.sourcePullRequestUrl,
          },
          {
            type: 2,
            style: 5,
            label: "H/p 인증 결과",
            url: registration.researchRunUrl,
          },
        ],
      },
    ],
  };
}

export function parseResearchCertificate(value: unknown): ResearchCertificate {
  if (!isRecord(value)) throw new Error("Research certificate is invalid.");
  assertResearchCertificateScope(value);
  const counts = parseResearchCertificateCounts(value);
  const solverWasmSha256 = parseSolverWasmSha256(value);
  const baseline = findBaselineCandidate(value);
  assertBaselineResult(baseline, counts.evaluatedProfileCount);
  return {
    ...counts,
    baselineCandidateId: "H0.75-p3",
    solverWasmSha256,
  };
}

export function assertResearchCertificateForecastCoverage(
  value: unknown,
  forecastId: string,
  expectedProfileIds: readonly string[],
) {
  if (
    !isRecord(value) ||
    !Array.isArray(value["profiles"]) ||
    !/^supply-\d{4}-\d{2}-\d{2}-v\d+$/.test(forecastId) ||
    expectedProfileIds.length === 0
  ) {
    throw new Error("Research certificate forecast coverage is invalid.");
  }
  const expected = new Set(expectedProfileIds);
  if (
    expected.size !== expectedProfileIds.length ||
    expectedProfileIds.some((profileId) => !profileId.startsWith(`${forecastId}@`))
  ) {
    throw new Error("Expected forecast profile identity is invalid.");
  }
  const evidenceIds = value["profiles"].flatMap((profile) => {
    if (!isRecord(profile) || !Array.isArray(profile["evidenceForecastProfileIds"])) {
      throw new Error("Research certificate evidence profile list is invalid.");
    }
    if (profile["evidenceForecastProfileIds"].some((profileId) => typeof profileId !== "string")) {
      throw new Error("Research certificate evidence profile ID is invalid.");
    }
    return profile["evidenceForecastProfileIds"] as string[];
  });
  const observed = new Set(
    evidenceIds.filter((profileId) => profileId.startsWith(`${forecastId}@`)),
  );
  if (
    observed.size !== expected.size ||
    [...expected].some((profileId) => !observed.has(profileId))
  ) {
    throw new Error("Research certificate does not cover the approved forecast profiles.");
  }
}

function assertResearchCertificateScope(value: Record<string, unknown>) {
  if (
    value["kind"] !== "dynamic-hp-exact-gate-summary" ||
    value["version"] !== 2 ||
    value["allProfilesComplete"] !== true ||
    !isRecord(value["decisionScope"]) ||
    value["decisionScope"]["researchOnly"] !== true ||
    value["decisionScope"]["productAdoptionAuthorized"] !== false
  ) {
    throw new Error("Research certificate scope is invalid.");
  }
}

function parseResearchCertificateCounts(value: Record<string, unknown>) {
  const profileCount = positiveInteger(value["profileCount"]);
  const evaluatedProfileCount = positiveInteger(value["evaluatedProfileCount"]);
  const duplicateProfileCount = nonNegativeInteger(value["duplicateProfileCount"]);
  if (profileCount === null || evaluatedProfileCount === null || duplicateProfileCount === null) {
    throw new Error("Research certificate profile counts are invalid.");
  }
  return { profileCount, evaluatedProfileCount, duplicateProfileCount };
}

function parseSolverWasmSha256(value: Record<string, unknown>) {
  const certificate = isRecord(value["certificate"]) ? value["certificate"] : null;
  const solverWasmSha256 =
    certificate && typeof certificate["solverWasmSha256"] === "string"
      ? certificate["solverWasmSha256"]
      : "";
  if (!/^[0-9a-f]{64}$/.test(solverWasmSha256)) {
    throw new Error("Research certificate solver identity is invalid.");
  }
  return solverWasmSha256;
}

function findBaselineCandidate(value: Record<string, unknown>) {
  const candidates = Array.isArray(value["candidates"]) ? value["candidates"] : [];
  return candidates.find(
    (candidate) => isRecord(candidate) && candidate["candidateId"] === "H0.75-p3",
  );
}

function assertBaselineResult(baseline: unknown, evaluatedProfileCount: number) {
  if (
    !isRecord(baseline) ||
    baseline["status"] !== "passed_all_profiles" ||
    baseline["exactPassed"] !== evaluatedProfileCount ||
    baseline["exactFailed"] !== 0 ||
    baseline["exactIncomplete"] !== 0
  ) {
    throw new Error("Research certificate baseline result is invalid.");
  }
}

async function main() {
  const target = parsePullRequestTarget(
    JSON.parse(await readFile(requiredEnvironment("DISCORD_SOURCE_PR_METADATA_FILE"), "utf8")),
  );
  const research = parseResearchCertificate(
    JSON.parse(await readFile(requiredEnvironment("DISCORD_RESEARCH_SUMMARY_FILE"), "utf8")),
  );
  const result = await sendDiscordStagingAdoption({
    collectorUrl: requiredEnvironment("FORECAST_COLLECTOR_URL"),
    collectorAdminToken: requiredEnvironment("FORECAST_COLLECTOR_ADMIN_TOKEN"),
    discordBotToken: requiredEnvironment("DISCORD_BOT_TOKEN"),
    discordChannelId: requiredEnvironment("DISCORD_CHANNEL_ID"),
    review: parseForecastReviewMetadata(target.body),
    sourcePullRequestNumber: Number(requiredEnvironment("DISCORD_SOURCE_PR_NUMBER")),
    sourcePullRequestUrl: requiredEnvironment("DISCORD_SOURCE_PR_URL"),
    sourceHeadSha: requiredEnvironment("DISCORD_SOURCE_HEAD_SHA"),
    registrySha: requiredEnvironment("DISCORD_REGISTRY_SHA"),
    researchRunId: Number(requiredEnvironment("DISCORD_RESEARCH_RUN_ID")),
    researchRunUrl: requiredEnvironment("DISCORD_RESEARCH_RUN_URL"),
    researchArtifactName: requiredEnvironment("DISCORD_RESEARCH_ARTIFACT_NAME"),
    researchArtifactDigest: requiredEnvironment("DISCORD_RESEARCH_ARTIFACT_DIGEST"),
    research,
    runId: requiredEnvironment("GITHUB_RUN_ID"),
    runAttempt: requiredEnvironment("GITHUB_RUN_ATTEMPT"),
  });
  console.log(`Discord staging approval message created: ${result.messageId}`);
}

function validateInput(input: DiscordStagingAdoptionInput) {
  if (!/^https:\/\//.test(input.collectorUrl)) throw new Error("Invalid collector URL.");
  if (!/^\d{1,24}$/.test(input.discordChannelId)) throw new Error("Invalid Discord channel ID.");
  validateSourceInput(input);
  validateResearchInput(input);
  if (!/^\d+$/.test(input.runId) || !/^\d+$/.test(input.runAttempt)) {
    throw new Error("Invalid GitHub Actions run identity.");
  }
}

function validateSourceInput(input: DiscordStagingAdoptionInput) {
  if (!/^supply-\d{4}-\d{2}-\d{2}-v\d+$/.test(input.review.forecastId)) {
    throw new Error("Invalid staging forecast ID.");
  }
  if (!Number.isInteger(input.sourcePullRequestNumber) || input.sourcePullRequestNumber <= 0) {
    throw new Error("Invalid source pull request number.");
  }
  if (
    input.sourcePullRequestUrl !==
    `https://github.com/${REPOSITORY}/pull/${input.sourcePullRequestNumber}`
  ) {
    throw new Error("Invalid source pull request URL.");
  }
  if (!/^[0-9a-f]{40}$/.test(input.sourceHeadSha) || !/^[0-9a-f]{40}$/.test(input.registrySha)) {
    throw new Error("Invalid source or registry SHA.");
  }
}

function validateResearchInput(input: DiscordStagingAdoptionInput) {
  if (!Number.isInteger(input.researchRunId) || input.researchRunId <= 0) {
    throw new Error("Invalid research run ID.");
  }
  if (
    input.researchRunUrl !== `https://github.com/${REPOSITORY}/actions/runs/${input.researchRunId}`
  ) {
    throw new Error("Invalid research run URL.");
  }
  if (input.researchArtifactName !== `dynamic-hp-exact-gate-summary-${input.researchRunId}`) {
    throw new Error("Invalid research artifact name.");
  }
  if (!/^[0-9a-f]{64}$/.test(input.researchArtifactDigest)) {
    throw new Error("Invalid research artifact digest.");
  }
}

function parsePullRequestTarget(value: unknown) {
  if (!isRecord(value) || typeof value["body"] !== "string") {
    throw new Error("Source pull request metadata is invalid.");
  }
  return { body: value["body"] };
}

function parseRegistration(value: unknown): ApprovalRegistration {
  if (
    !isRecord(value) ||
    typeof value["approvalId"] !== "string" ||
    typeof value["customId"] !== "string" ||
    typeof value["forecastId"] !== "string" ||
    typeof value["sourcePullRequestUrl"] !== "string" ||
    typeof value["researchRunUrl"] !== "string" ||
    typeof value["expiresAt"] !== "string" ||
    !["pending", "approved", "adoption_pr_created", "expired"].includes(String(value["state"])) ||
    (value["discordChannelId"] !== null && typeof value["discordChannelId"] !== "string") ||
    (value["discordMessageId"] !== null && typeof value["discordMessageId"] !== "string")
  ) {
    throw new Error("Collector returned an invalid staging approval registration.");
  }
  return {
    approvalId: value["approvalId"],
    customId: value["customId"],
    forecastId: value["forecastId"],
    sourcePullRequestUrl: value["sourcePullRequestUrl"],
    researchRunUrl: value["researchRunUrl"],
    expiresAt: value["expiresAt"],
    state: value["state"] as ApprovalRegistration["state"],
    discordChannelId: value["discordChannelId"] as string | null,
    discordMessageId: value["discordMessageId"] as string | null,
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function positiveInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function nonNegativeInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
