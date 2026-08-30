import { STAGING_FORECAST_REVIEW_URL } from "../../shared/runtimeEnvironment";

export const DISCORD_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
export const DISCORD_INTERACTION_MAX_BYTES = 64 * 1024;
export const TEST_APPROVAL_TTL_MS = 30 * 60 * 1000;
export const STAGING_ADOPTION_TTL_MS = 24 * 60 * 60 * 1000;
export const CUSTOM_ID_PREFIX = "forecast_test_approve:";
export const STAGING_CUSTOM_ID_PREFIX = "forecast_staging_approve:";

const REPOSITORY_PATH = "/just-goforward/Nikke-Collection-Item-Calculator";

export type DiscordApprovalTestInput = {
  requestKey: string;
  candidateId: string;
  forecastId: string;
  payloadHash: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  headSha: string;
};

export type DiscordStagingAdoptionInput = {
  requestKey: string;
  forecastId: string;
  payloadHash: string;
  sourcePullRequestNumber: number;
  sourcePullRequestUrl: string;
  sourceHeadSha: string;
  registrySha: string;
  researchRunId: number;
  researchRunUrl: string;
  researchArtifactName: string;
  researchArtifactDigest: string;
};

export type DiscordApprovalView = {
  forecastId: string;
  pullRequestUrl: string;
};

export type DiscordStagingAdoptionView = {
  forecastId: string;
  researchRunUrl: string;
};

export function parseDiscordApprovalTestInput(value: unknown): DiscordApprovalTestInput {
  if (!isRecord(value)) throw new Error("invalid_discord_test_approval");
  const input = {
    requestKey: stringMatching(value["requestKey"], /^[0-9a-f]{64}$/),
    candidateId: stringMatching(value["candidateId"], /^forecast-[a-z0-9-]{1,80}$/),
    forecastId: stringMatching(value["forecastId"], /^supply-[a-z0-9-]{1,80}$/),
    payloadHash: stringMatching(value["payloadHash"], /^[0-9a-f]{64}$/),
    pullRequestNumber: positiveInteger(value["pullRequestNumber"]),
    pullRequestUrl: stringMatching(value["pullRequestUrl"], /^https:\/\/github\.com\//),
    headSha: stringMatching(value["headSha"], /^[0-9a-f]{40}$/),
  };
  if (Object.values(input).some((entry) => entry === null)) {
    throw new Error("invalid_discord_test_approval");
  }
  assertRepositoryUrl(
    input.pullRequestUrl as string,
    `/pull/${input.pullRequestNumber}`,
    "invalid_discord_test_pull_request_url",
  );
  return input as DiscordApprovalTestInput;
}

export function parseDiscordStagingAdoptionInput(value: unknown): DiscordStagingAdoptionInput {
  if (!isRecord(value)) throw new Error("invalid_discord_staging_adoption");
  const input = {
    requestKey: stringMatching(value["requestKey"], /^[0-9a-f]{64}$/),
    forecastId: stringMatching(value["forecastId"], /^supply-\d{4}-\d{2}-\d{2}-v\d+$/),
    payloadHash: stringMatching(value["payloadHash"], /^[0-9a-f]{64}$/),
    sourcePullRequestNumber: positiveInteger(value["sourcePullRequestNumber"]),
    sourcePullRequestUrl: stringMatching(value["sourcePullRequestUrl"], /^https:\/\/github\.com\//),
    sourceHeadSha: stringMatching(value["sourceHeadSha"], /^[0-9a-f]{40}$/),
    registrySha: stringMatching(value["registrySha"], /^[0-9a-f]{40}$/),
    researchRunId: positiveInteger(value["researchRunId"]),
    researchRunUrl: stringMatching(value["researchRunUrl"], /^https:\/\/github\.com\//),
    researchArtifactName: stringMatching(
      value["researchArtifactName"],
      /^dynamic-hp-exact-gate-summary-[1-9][0-9]*$/,
    ),
    researchArtifactDigest: stringMatching(value["researchArtifactDigest"], /^[0-9a-f]{64}$/),
  };
  if (Object.values(input).some((entry) => entry === null)) {
    throw new Error("invalid_discord_staging_adoption");
  }
  assertRepositoryUrl(
    input.sourcePullRequestUrl as string,
    `/pull/${input.sourcePullRequestNumber}`,
    "invalid_discord_staging_source_pr_url",
  );
  assertRepositoryUrl(
    input.researchRunUrl as string,
    `/actions/runs/${input.researchRunId}`,
    "invalid_discord_staging_research_url",
  );
  return input as DiscordStagingAdoptionInput;
}

export function parseStagingAdoptionResult(value: unknown) {
  if (!isRecord(value)) throw new Error("invalid_discord_staging_result");
  const result = {
    adoptionPullRequestNumber: positiveInteger(value["adoptionPullRequestNumber"]),
    adoptionPullRequestUrl: stringMatching(
      value["adoptionPullRequestUrl"],
      /^https:\/\/github\.com\//,
    ),
    stagingUrl:
      value["stagingUrl"] === STAGING_FORECAST_REVIEW_URL ? STAGING_FORECAST_REVIEW_URL : null,
  };
  if (Object.values(result).some((entry) => entry === null)) {
    throw new Error("invalid_discord_staging_result");
  }
  assertRepositoryUrl(
    result.adoptionPullRequestUrl as string,
    `/pull/${result.adoptionPullRequestNumber}`,
    "invalid_discord_staging_adoption_pr_url",
  );
  return result as {
    adoptionPullRequestNumber: number;
    adoptionPullRequestUrl: string;
    stagingUrl: string;
  };
}

export function parseStagingAdoptionMessage(value: unknown) {
  if (!isRecord(value)) throw new Error("invalid_discord_staging_message");
  const input = {
    discordChannelId: stringMatching(value["discordChannelId"], /^\d{1,24}$/),
    discordMessageId: stringMatching(value["discordMessageId"], /^\d{1,24}$/),
  };
  if (Object.values(input).some((entry) => entry === null)) {
    throw new Error("invalid_discord_staging_message");
  }
  return input as { discordChannelId: string; discordMessageId: string };
}

export function approvedData(approval: DiscordApprovalView, customId: string) {
  return {
    content:
      `Forecast \`${approval.forecastId}\`의 Discord 승인 응답 테스트가 완료되었습니다.\n` +
      "D1에는 `test_approved`만 기록되었으며 staging·production Forecast와 GitHub PR은 변경되지 않았습니다.",
    allowed_mentions: { parse: [] },
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "테스트 승인 완료",
            custom_id: customId,
            disabled: true,
          },
          {
            type: 2,
            style: 5,
            label: "GitHub PR 열기",
            url: approval.pullRequestUrl,
          },
        ],
      },
    ],
  };
}

export function stagingApprovedData(approval: DiscordStagingAdoptionView, customId: string) {
  return {
    content:
      `Forecast \`${approval.forecastId}\`의 staging 적용 승인이 기록되었습니다.\n` +
      "GitHub Actions가 adoption PR을 생성합니다. PR 병합과 Pages 배포 후 " +
      `${STAGING_FORECAST_REVIEW_URL}에서 검증할 수 있으며 기본 production 환경은 변경되지 않습니다.`,
    allowed_mentions: { parse: [] },
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "staging 적용 승인 완료",
            custom_id: customId,
            disabled: true,
          },
          {
            type: 2,
            style: 5,
            label: "H/p 인증 결과 열기",
            url: approval.researchRunUrl,
          },
        ],
      },
    ],
  };
}

export function unavailableApprovalData(content: string) {
  return {
    content,
    allowed_mentions: { parse: [] },
    components: [],
  };
}

export function approvalFailureData() {
  return {
    content: "승인 기록 중 오류가 발생했습니다. 버튼을 다시 누르거나 새 승인 카드를 요청하십시오.",
    allowed_mentions: { parse: [] },
  };
}

export function boundedString(value: unknown, maxLength: number) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return null;
  }
  return value;
}

export function stringMatching(value: unknown, pattern: RegExp) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function positiveInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function assertRepositoryUrl(value: string, suffix: string, error: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.pathname !== `${REPOSITORY_PATH}${suffix}` ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
