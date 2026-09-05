import { readBoundedBytes } from "../../shared/boundedHttp";
import type { ObserverAlertRow, StatsObserverEnv } from "./types";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_RESPONSE_BYTES = 16_384;

export class DiscordObserverError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(code);
    this.name = "DiscordObserverError";
  }
}

function alertPayload(env: StatsObserverEnv, alert: ObserverAlertRow) {
  const context = safeContext(alert.context_json);
  const revision = String(context["appRevision"] ?? "unknown");
  const revisionLine = /^[0-9a-f]{40}$/.test(revision)
    ? `[${revision.slice(0, 8)}](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/commit/${revision})`
    : clean(revision, 48);
  const contextLines = Object.entries(context)
    .filter(([key]) => key !== "appRevision")
    .slice(0, 10)
    .map(([key, value]) => `**${clean(key, 36)}:** ${clean(String(value), 180)}`);
  return {
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title:
          alert.state === "resolved"
            ? "Solver 운영 복구"
            : alert.severity === "critical"
              ? "Solver 운영 오류"
              : "Solver 운영 경고",
        description: [
          `환경: **${env.ENVIRONMENT}**`,
          `오류 범주: \`${clean(alert.error_code, 64)}\``,
          `App revision: ${revisionLine}`,
          `신규 구간: ${alert.window_count}건 / 누적: ${alert.total_count}건`,
          `최초: ${kst(alert.first_seen)} / 최근: ${kst(alert.last_seen)}`,
          ...contextLines,
        ].join("\n"),
        color:
          alert.state === "resolved"
            ? 0x2ecc71
            : alert.severity === "critical"
              ? 0xe74c3c
              : 0xf1c40f,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export async function deliverAlert(
  env: StatsObserverEnv,
  alert: ObserverAlertRow,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
) {
  if (!/^\d{6,24}$/.test(env.DISCORD_ALERT_CHANNEL_ID)) {
    throw new DiscordObserverError("discord_alert_channel_invalid", false);
  }
  if (!env.DISCORD_BOT_TOKEN) {
    throw new DiscordObserverError("discord_bot_token_missing", false);
  }
  const withinWindow =
    alert.last_sent_at !== null && nowMs - Date.parse(alert.last_sent_at) < 30 * 60_000;
  const canUpdate =
    alert.state === "open" &&
    withinWindow &&
    alert.last_sent_severity === alert.severity &&
    /^\d{6,24}$/.test(alert.discord_message_id ?? "");
  const method = canUpdate ? "PATCH" : "POST";
  const url = canUpdate
    ? `${DISCORD_API}/channels/${env.DISCORD_ALERT_CHANNEL_ID}/messages/${alert.discord_message_id}`
    : `${DISCORD_API}/channels/${env.DISCORD_ALERT_CHANNEL_ID}/messages`;
  const payload = alertPayload(env, alert) as Record<string, unknown>;
  if (!canUpdate) {
    payload["nonce"] = alertNonce(alert);
    payload["enforce_nonce"] = true;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
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
    const code = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
    throw new DiscordObserverError(`discord_${code}`, true);
  }
  if (response.status === 429) {
    throw new DiscordObserverError("discord_429", true, await retryAfter(response));
  }
  if (!response.ok) {
    throw new DiscordObserverError(`discord_${response.status}`, response.status >= 500);
  }
  const body = await responseJson(response);
  const messageId = isRecord(body) ? body["id"] : null;
  if (typeof messageId !== "string" || !/^\d{6,24}$/.test(messageId)) {
    throw new DiscordObserverError("discord_message_id_missing", false);
  }
  return messageId;
}

function alertNonce(alert: ObserverAlertRow) {
  const window = Math.max(0, Date.parse(alert.window_started_at)).toString(36).slice(-8);
  return `${alert.fingerprint.slice(0, 12)}-${alert.state[0]}${alert.severity[0]}-${window}`.slice(
    0,
    25,
  );
}

async function retryAfter(response: Response) {
  try {
    const body = await responseJson(response);
    const seconds = isRecord(body) ? Number(body["retry_after"]) : Number.NaN;
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.max(seconds * 1_000, 250), 60 * 60_000);
    }
  } catch {
    // The durable retry uses a conservative fallback when Discord omits a valid delay.
  }
  return 5 * 60_000;
}

async function responseJson(response: Response) {
  try {
    const bytes = await readBoundedBytes(
      response,
      MAX_RESPONSE_BYTES,
      "discord_response_too_large",
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof DiscordObserverError) throw error;
    throw new DiscordObserverError("discord_response_invalid", false);
  }
}

function safeContext(value: string): Record<string, string | number> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string | number] =>
          typeof entry[1] === "string" || typeof entry[1] === "number",
      ),
    );
  } catch {
    return {};
  }
}

function kst(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(timestamp))
    : "unknown";
}

function clean(value: string, max: number) {
  let printable = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    printable +=
      codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? " " : character;
  }
  return printable.replace(/\s+/g, " ").trim().slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
