import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type ForecastReviewMetadata,
  formatForecastReviewForDiscord,
  parseForecastReviewMetadata,
} from "./supply-forecast-proposal.ts";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const REPOSITORY = "just-goforward/Nikke-Collection-Item-Calculator";

export type DiscordForecastApprovalTestInput = {
  collectorUrl: string;
  collectorAdminToken: string;
  discordBotToken: string;
  discordChannelId: string;
  review: ForecastReviewMetadata;
  pullRequestNumber: number;
  pullRequestUrl: string;
  headSha: string;
  runId: string;
  runAttempt: string;
};

type ApprovalRegistration = {
  approvalId: string;
  customId: string;
  candidateId: string;
  pullRequestUrl: string;
  expiresAt: string;
};

export async function sendDiscordForecastApprovalTest(
  input: DiscordForecastApprovalTestInput,
  fetcher: typeof fetch = fetch,
) {
  validateInput(input);
  const payloadHash = sha256(
    JSON.stringify({
      candidateId: input.review.candidateId,
      forecastId: input.review.forecastId,
      pullRequestNumber: input.pullRequestNumber,
      pullRequestUrl: input.pullRequestUrl,
      headSha: input.headSha,
    }),
  );
  const requestKey = sha256(`${input.runId}:${input.runAttempt}:${payloadHash}`);
  const registrationResponse = await fetcher(
    `${input.collectorUrl.replace(/\/$/, "")}/admin/discord-test-approvals`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.collectorAdminToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        requestKey,
        candidateId: input.review.candidateId,
        forecastId: input.review.forecastId,
        payloadHash,
        pullRequestNumber: input.pullRequestNumber,
        pullRequestUrl: input.pullRequestUrl,
        headSha: input.headSha,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!registrationResponse.ok) {
    throw new Error(`Discord approval registration failed with ${registrationResponse.status}.`);
  }
  const registration = parseRegistration(await registrationResponse.json());
  const messageResponse = await fetcher(
    `${DISCORD_API_BASE}/channels/${input.discordChannelId}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bot ${input.discordBotToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(buildDiscordForecastApprovalTestMessage(registration, input.review)),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!messageResponse.ok) {
    throw new Error(`Discord test message failed with ${messageResponse.status}.`);
  }
  const message: unknown = await messageResponse.json();
  if (!isRecord(message) || typeof message["id"] !== "string") {
    throw new Error("Discord returned an invalid message response.");
  }
  return { approvalId: registration.approvalId, messageId: message["id"], payloadHash };
}

export function buildDiscordForecastApprovalTestMessage(
  registration: ApprovalRegistration,
  review: ForecastReviewMetadata,
) {
  const summary = formatForecastReviewForDiscord(review);
  return {
    content:
      `${summary.content}\n\n` +
      "> 테스트 전용: 확인 버튼은 D1에 `test_approved`만 기록하며 PR이나 Forecast를 변경하지 않습니다.",
    allowed_mentions: { parse: [] },
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "확인 완료 (테스트)",
            custom_id: registration.customId,
          },
          {
            type: 2,
            style: 5,
            label: "GitHub PR 열기",
            url: registration.pullRequestUrl,
          },
        ],
      },
    ],
  };
}

async function main() {
  const target = parsePullRequestTarget(
    JSON.parse(
      await readFile(requiredEnvironment("DISCORD_TEST_PR_METADATA_FILE"), "utf8"),
    ) as unknown,
  );
  const result = await sendDiscordForecastApprovalTest({
    collectorUrl: requiredEnvironment("FORECAST_COLLECTOR_URL"),
    collectorAdminToken: requiredEnvironment("FORECAST_COLLECTOR_ADMIN_TOKEN"),
    discordBotToken: requiredEnvironment("DISCORD_BOT_TOKEN"),
    discordChannelId: requiredEnvironment("DISCORD_CHANNEL_ID"),
    review: parseForecastReviewMetadata(target.body),
    pullRequestNumber: Number(requiredEnvironment("DISCORD_TEST_PR_NUMBER")),
    pullRequestUrl: requiredEnvironment("DISCORD_TEST_PR_URL"),
    headSha: requiredEnvironment("DISCORD_TEST_HEAD_SHA"),
    runId: requiredEnvironment("GITHUB_RUN_ID"),
    runAttempt: requiredEnvironment("GITHUB_RUN_ATTEMPT"),
  });
  console.log(`Discord approval test message created: ${result.messageId}`);
}

function validateInput(input: DiscordForecastApprovalTestInput) {
  if (!/^https:\/\//.test(input.collectorUrl)) throw new Error("Invalid collector URL.");
  if (!/^\d{1,24}$/.test(input.discordChannelId)) throw new Error("Invalid Discord channel ID.");
  if (!/^forecast-[a-z0-9-]{8,120}$/.test(input.review.candidateId)) {
    throw new Error("Invalid Discord test candidate ID.");
  }
  if (!/^supply-\d{4}-\d{2}-\d{2}-v\d+$/.test(input.review.forecastId)) {
    throw new Error("Invalid Discord test forecast ID.");
  }
  if (!Number.isInteger(input.pullRequestNumber) || input.pullRequestNumber <= 0) {
    throw new Error("Invalid pull request number.");
  }
  const expectedUrl = `https://github.com/${REPOSITORY}/pull/${input.pullRequestNumber}`;
  if (input.pullRequestUrl !== expectedUrl) throw new Error("Invalid pull request URL.");
  if (!/^[0-9a-f]{40}$/.test(input.headSha)) throw new Error("Invalid pull request head SHA.");
  if (!/^\d+$/.test(input.runId) || !/^\d+$/.test(input.runAttempt)) {
    throw new Error("Invalid GitHub Actions run identity.");
  }
}

function parsePullRequestTarget(value: unknown) {
  if (!isRecord(value) || typeof value["body"] !== "string") {
    throw new Error("Pull request metadata is invalid.");
  }
  return { body: value["body"] };
}

function parseRegistration(value: unknown): ApprovalRegistration {
  if (
    !isRecord(value) ||
    typeof value["approvalId"] !== "string" ||
    typeof value["customId"] !== "string" ||
    typeof value["candidateId"] !== "string" ||
    typeof value["pullRequestUrl"] !== "string" ||
    typeof value["expiresAt"] !== "string"
  ) {
    throw new Error("Collector returned an invalid Discord approval registration.");
  }
  return {
    approvalId: value["approvalId"],
    customId: value["customId"],
    candidateId: value["candidateId"],
    pullRequestUrl: value["pullRequestUrl"],
    expiresAt: value["expiresAt"],
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
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
