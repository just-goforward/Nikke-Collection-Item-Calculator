import { readBoundedBytes } from "../../shared/boundedHttp.ts";
import { errorCode } from "../../shared/errorCodes.ts";
import {
  type BudgetIncidentKind,
  budgetGameDayResetAt,
  parseBudgetIncidentKey,
} from "../../shared/forecastOpsAlerts.ts";
import { kstLabel } from "../../shared/forecastV2Notifications.ts";
import { sha256Hex } from "./crypto";
import type { DispatcherEnv, OpsAlertRow } from "./types";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_RESPONSE_BYTES = 16_384;

type FetchLike = typeof fetch;
export type DiscordChannelKind = "activity" | "alert" | "approval";

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

export function discordRetryable(error: unknown) {
  return !(error instanceof DiscordMessageError) || error.retryable;
}

/** Only uncertain outcomes may have created a message; permission/429 did not. */
export function discordAmbiguous(error: unknown) {
  return (
    error instanceof DiscordMessageError &&
    /^discord_(network|timeout|response_|create_message_5)/.test(error.message)
  );
}

export async function opsAlertMessage(alert: OpsAlertRow) {
  const incident = parseBudgetIncidentKey(alert.alertKey);
  if (incident) return budgetIncidentMessage(alert, incident.kind, incident.gameDay);
  const nonce = await alertNonce(alert, "alert");
  const context = Object.entries(alert.context)
    .slice(0, 6)
    .map(([key, value]) => `${cleanText(key, 40)}: ${cleanText(String(value), 180)}`)
    .join("\n");
  return {
    nonce,
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

export async function opsRecoveryMessage(alert: OpsAlertRow) {
  return {
    nonce: await alertNonce(alert, "recovery"),
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

/** One Korean incident notice per budget kind and game day, in the v2 guidance style. */
async function budgetIncidentMessage(
  alert: OpsAlertRow,
  kind: BudgetIncidentKind,
  gameDay: string,
) {
  const subject = kind === "metadata" ? "공지 목록 조회" : "공지 본문 조회";
  const used = numberContext(alert.context["used"]);
  const limit = numberContext(alert.context["limit"]);
  const quota =
    used !== null && limit !== null
      ? `오늘 ${subject} 한도 ${formatCount(used)}/${formatCount(limit)}회를 모두 사용했습니다.`
      : `오늘 ${subject} 한도를 모두 사용했습니다.`;
  const resetAt = resetInstant(alert.context["resetAt"], gameDay);
  const streams = affectedStreams(alert.context["affectedStreams"]);
  const impact =
    kind === "metadata"
      ? `다음 한도가 적용될 때까지 새 공지·수정 공지 확인이 멈춥니다(감시: ${streams}).`
      : `새 공지 본문 확인과 자동 판정이 다음 한도까지 늦어집니다. 본문을 기다리는 감시는 목록 확인도 함께 늦어질 수 있습니다(감시: ${streams}).`;
  return {
    // Incident-stable: a later hold only raises the occurrence count, and the same
    // message must not be posted again under a new nonce.
    nonce: await stableNonce(["forecast-ops-budget-v1", alert.environment, alert.alertKey]),
    enforce_nonce: true,
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: "Forecast 운영 경고",
        description: [
          `**Forecast 공지 수집 일시 대기** · 환경: ${alert.environment}`,
          `❌ 무슨 일이: ${quota} 승인 오류가 아니라 Naver 요청량을 제한하는 보호 장치입니다.`,
          `📌 영향: ${impact} 이미 저장된 내용의 승인 처리는 계속됩니다.`,
          `🕔 자동 재개: ${kstLabel(resetAt)} KST에 새 한도가 적용되고 다음 수집 차례에 자동으로 다시 확인합니다.`,
          "👉 해 주실 일: 할 일 없음. 이 경고 때문에 승인을 다시 누르지 마세요. 매일 반복되면 운영자가 요청량을 점검해야 합니다.",
        ].join("\n"),
        color: 0xf1c40f,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/** Only a stored number renders; a missing or malformed value stays unknown. */
function numberContext(value: string | number | boolean | null | undefined) {
  if (typeof value === "boolean" || value === null || value === undefined || value === "")
    return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatCount(value: number) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The incident's reset instant; legacy contexts without it derive it from the game day. */
function resetInstant(value: string | number | boolean | null | undefined, gameDay: string) {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  return budgetGameDayResetAt(gameDay);
}

function affectedStreams(value: string | number | boolean | null | undefined) {
  const names = String(value ?? "")
    .split(",")
    .map((name) => cleanText(name, 12))
    .filter(Boolean);
  return names.length ? names.join(", ") : "전체 스트림";
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
      response.status >= 500,
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
  if (kind === "approval") {
    if (!/^\d{6,24}$/.test(env.DISCORD_APPROVAL_CHANNEL_ID ?? ""))
      throw new DiscordMessageError("discord_approval_channel_id_invalid", false);
    return env.DISCORD_APPROVAL_CHANNEL_ID;
  }
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

/**
 * A 429 body we cannot read still means "slow down"; the fixed fallback keeps the
 * alert durable in D1. The reason is reported so a Discord schema change (or an
 * oversized body) stays visible instead of hiding behind the fallback delay.
 */
async function readRetryAfter(response: Response) {
  let problem = "retry_after_missing";
  try {
    const bytes = await boundedResponseBytes(response);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const retryAfter = isRecord(parsed) ? Number(parsed["retry_after"]) : Number.NaN;
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      return Math.min(Math.max(retryAfter * 1_000, 250), 60 * 60 * 1_000);
    }
  } catch (error) {
    // Only the registered oversize code is reported by name; a parse failure (or a forged
    // message on a DiscordMessageError) stays the fixed "unreadable" reason.
    problem =
      errorCode(error) === "discord_response_too_large"
        ? "discord_response_too_large"
        : "retry_after_unreadable";
  }
  console.warn(
    JSON.stringify({
      event: "discord_retry_after_fallback",
      code: problem,
      status: response.status,
    }),
  );
  return 5 * 60 * 1_000;
}

async function boundedResponseBytes(response: Response) {
  try {
    return await readBoundedBytes(response, MAX_RESPONSE_BYTES, "discord_response_too_large");
  } catch {
    throw new DiscordMessageError("discord_response_too_large", false);
  }
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

async function alertNonce(alert: OpsAlertRow, kind: "alert" | "recovery") {
  const identity = JSON.stringify([
    "forecast-ops-v1",
    alert.environment,
    alert.alertKey,
    alert.firstSeenAt,
    kind,
    alert.occurrenceCount,
    kind === "recovery" ? alert.resolvedAt : null,
  ]);
  return (await sha256Hex(identity)).slice(0, 25);
}

/** Nonce for a message whose identity must not move as its counters change. */
async function stableNonce(identity: string[]) {
  return (await sha256Hex(JSON.stringify(identity))).slice(0, 25);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
