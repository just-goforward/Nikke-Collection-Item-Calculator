import type { DispatcherEnv, DispatchReservation, OpsAlertRow } from "./types";

const DISCORD_API = "https://discord.com/api/v10";
const WORKFLOW_URL =
  "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/workflows/forecast-proposal.yml";
const MAX_RESPONSE_BYTES = 16_384;

type FetchLike = typeof fetch;
type Delay = (milliseconds: number) => Promise<void>;

export class DiscordMessageError extends Error {
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(code);
    this.name = "DiscordMessageError";
    this.retryable = retryable;
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
  payload: object,
  options: { fetchImpl?: FetchLike; delay?: Delay } = {},
) {
  if (!/^\d{6,24}$/.test(env.DISCORD_CHANNEL_ID)) {
    throw new DiscordMessageError("discord_channel_id_invalid", false);
  }
  if (!env.DISCORD_BOT_TOKEN) throw new DiscordMessageError("discord_bot_token_missing", false);
  const fetchImpl = options.fetchImpl ?? fetch;
  const delay =
    options.delay ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let response = await createMessage(env, payload, fetchImpl);
  if (response.status === 429) {
    const retryAfterMs = await readRetryAfter(response);
    await delay(retryAfterMs);
    response = await createMessage(env, payload, fetchImpl);
  } else if (response.status >= 500) {
    await delay(1_000);
    response = await createMessage(env, payload, fetchImpl);
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
  return { messageId: id };
}

async function createMessage(env: DispatcherEnv, payload: object, fetchImpl: FetchLike) {
  try {
    return await fetchImpl(`${DISCORD_API}/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
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
      return Math.min(Math.max(retryAfter * 1_000, 250), 10_000);
    }
  } catch {
    // The fallback delay is intentionally short; the unsent alert remains durable in D1.
  }
  return 1_000;
}

async function boundedResponseBytes(response: Response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new DiscordMessageError("discord_response_too_large", false);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) {
    throw new DiscordMessageError("discord_response_too_large", false);
  }
  return bytes;
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
