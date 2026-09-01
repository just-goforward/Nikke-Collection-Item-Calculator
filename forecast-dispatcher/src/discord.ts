import { readBoundedBytes } from "../../shared/boundedHttp";
import type { DispatcherEnv, DispatchReservation, OpsAlertRow } from "./types";

const DISCORD_API = "https://discord.com/api/v10";
const WORKFLOW_URL =
  "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/workflows/forecast-proposal.yml";
const MANUAL_REVIEW_WORKFLOW_URL =
  "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/workflows/resolve-forecast-manual-review.yml";
const MAX_RESPONSE_BYTES = 16_384;

type FetchLike = typeof fetch;
export type DiscordChannelKind = "activity" | "alert";

export class DiscordMessageError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(code: string, retryable: boolean, retryAfterMs: number | null = null) {
    super(code);
    this.name = "DiscordMessageError";
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export function dispatchAcceptedMessage(env: DispatcherEnv, reservation: DispatchReservation) {
  const links = reservation.links.slice(0, 3).map((item) => {
    const title = cleanText(item.title, 100);
    return `- [${escapeMarkdown(title)}](${validatedNaverUrl(item.url)})`;
  });
  const workSummary =
    reservation.mode === "smoke"
      ? "staging smoke 요청입니다. queue, candidate, 저장소 파일은 변경하지 않습니다."
      : `pending ${reservation.pendingCount}건 / candidate ${reservation.candidateCount}건`;
  return {
    nonce: reservation.dispatchId.slice(3, 28),
    enforce_nonce: true,
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: "Forecast workflow 실행 요청 접수",
        description: [
          `환경: **${env.ENVIRONMENT}**`,
          workSummary,
          links.length > 0 ? `\n확인 대상\n${links.join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        color: 0x3498db,
        fields: [
          { name: "Dispatch ID", value: `\`${reservation.dispatchId}\``, inline: false },
          { name: "상태", value: "GitHub가 실행 요청을 접수했습니다. 완료 상태가 아닙니다." },
        ],
        url: WORKFLOW_URL,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export function opsAlertMessage(alert: OpsAlertRow) {
  const manualReview = manualReviewMessage(alert);
  if (manualReview) return manualReview;
  const context = Object.entries(alert.context)
    .slice(0, 6)
    .map(([key, value]) => `${cleanText(key, 40)}: ${cleanText(String(value), 180)}`)
    .join("\n");
  return {
    nonce: alertNonce(alert.alertKey, alert.occurrenceCount),
    enforce_nonce: true,
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: alert.severity === "critical" ? "Forecast 운영 오류" : "Forecast 운영 경고",
        description: [
          `환경: **${alert.environment}**`,
          `구성요소: **${cleanText(alert.component, 48)}**`,
          `오류 코드: \`${cleanText(alert.errorCode, 80)}\``,
          `누적 발생: ${alert.occurrenceCount}회`,
          context ? `\n${context}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        color: alert.severity === "critical" ? 0xe74c3c : 0xf1c40f,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

function manualReviewMessage(alert: OpsAlertRow) {
  if (!alert.alertKey.startsWith("manual-review:")) return null;
  const reviewId = typeof alert.context["reviewId"] === "string" ? alert.context["reviewId"] : "";
  const sourceUrl = typeof alert.context["url"] === "string" ? alert.context["url"] : "";
  if (!/^mr-[0-9a-f]{32}$/.test(reviewId)) return null;
  const environment = alert.environment;
  const reason = cleanText(String(alert.context["reason"] ?? alert.errorCode), 80);
  const title = cleanText(String(alert.context["title"] ?? "Naver 일정 게시물"), 120);
  return {
    nonce: alertNonce(alert.alertKey, alert.occurrenceCount),
    enforce_nonce: true,
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: "Forecast 수동 검토 필요",
        description: [
          `환경: **${environment}**`,
          `게시물: ${escapeMarkdown(title)}`,
          `사유: \`${reason}\``,
          `검토 ID: \`${reviewId}\``,
        ].join("\n"),
        color: 0xf1c40f,
        timestamp: new Date().toISOString(),
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: "원문 열기", url: validatedNaverUrl(sourceUrl) },
          {
            type: 2,
            style: 1,
            custom_id: `forecast_manual_${environment}_requeue:${reviewId}`,
            label: "재처리",
          },
          {
            type: 2,
            style: 2,
            custom_id: `forecast_manual_${environment}_ignore:${reviewId}`,
            label: "관련 없음",
          },
          {
            type: 2,
            style: 5,
            label: "일정 직접 확정",
            url: MANUAL_REVIEW_WORKFLOW_URL,
          },
        ],
      },
    ],
  };
}

export function opsRecoveryMessage(alert: OpsAlertRow) {
  return {
    nonce: alertNonce(`recovery:${alert.alertKey}`, alert.occurrenceCount),
    enforce_nonce: true,
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: "Forecast 운영 상태 복구",
        description: [
          `환경: **${alert.environment}**`,
          `구성요소: **${cleanText(alert.component, 48)}**`,
          `해소된 오류: \`${cleanText(alert.errorCode, 80)}\``,
        ].join("\n"),
        color: 0x2ecc71,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export async function sendDiscordMessage(
  env: DispatcherEnv,
  channelKind: DiscordChannelKind,
  payload: object,
  options: { fetchImpl?: FetchLike } = {},
) {
  const channelId = resolveDiscordChannelId(env, channelKind);
  if (!env.DISCORD_BOT_TOKEN) throw new DiscordMessageError("discord_bot_token_missing", false);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await createMessage(env, channelId, payload, fetchImpl);
  if (response.status === 429) {
    const retryAfterMs = await readRetryAfter(response);
    throw new DiscordMessageError("discord_create_message_429", true, retryAfterMs);
  }
  if (!response.ok) {
    throw new DiscordMessageError(
      `discord_create_message_${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  }
  const bytes = await boundedResponseBytes(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DiscordMessageError("discord_response_invalid_json", false);
  }
  const id = isRecord(parsed) ? parsed["id"] : null;
  if (typeof id !== "string" || !/^\d{6,24}$/.test(id)) {
    throw new DiscordMessageError("discord_response_message_id_missing", false);
  }
  return { messageId: id, channelId };
}

export function resolveDiscordChannelId(env: DispatcherEnv, kind: DiscordChannelKind) {
  const preferred =
    kind === "activity" ? env.DISCORD_ACTIVITY_CHANNEL_ID : env.DISCORD_ALERT_CHANNEL_ID;
  const candidates = [preferred, env.DISCORD_FALLBACK_CHANNEL_ID, env.DISCORD_CHANNEL_ID];
  const selected = candidates.find((value) => /^\d{6,24}$/.test(value ?? ""));
  if (!selected) {
    throw new DiscordMessageError(`discord_${kind}_channel_id_invalid`, false);
  }
  return selected;
}

async function createMessage(
  env: DispatcherEnv,
  channelId: string,
  payload: object,
  fetchImpl: FetchLike,
) {
  try {
    return await fetchImpl(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "content-type": "application/json",
        "user-agent":
          "DiscordBot (https://github.com/just-goforward/Nikke-Collection-Item-Calculator, 1.0)",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    const suffix = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
    throw new DiscordMessageError(`discord_${suffix}`, true);
  }
}

async function readRetryAfter(response: Response) {
  try {
    const bytes = await boundedResponseBytes(response);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const retryAfter = isRecord(parsed) ? Number(parsed["retry_after"]) : Number.NaN;
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      return Math.min(Math.max(retryAfter * 1_000, 250), 60 * 60 * 1_000);
    }
  } catch {
    // The fallback delay is intentionally short; the unsent alert remains durable in D1.
  }
  return 5 * 60 * 1_000;
}

async function boundedResponseBytes(response: Response) {
  try {
    return await readBoundedBytes(response, MAX_RESPONSE_BYTES, "discord_response_too_large");
  } catch {
    throw new DiscordMessageError("discord_response_too_large", false);
  }
}

function validatedNaverUrl(value: string) {
  const url = URL.parse(value);
  if (url?.protocol !== "https:" || url.hostname !== "game.naver.com") {
    return "https://game.naver.com/lounge/nikke/home";
  }
  return url.toString();
}

function cleanText(value: string, maxLength: number) {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function escapeMarkdown(value: string) {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>@]/g, "\\$&");
}

function alertNonce(key: string, count: number) {
  return (
    `${key.replace(/[^a-zA-Z0-9]/g, "").slice(0, 18)}${count}`.slice(0, 25) || `forecast${count}`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
