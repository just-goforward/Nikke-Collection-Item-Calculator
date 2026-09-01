import { pathToFileURL } from "node:url";

const DISCORD_API = "https://discord.com/api/v10";

type RoutingSmokeInput = {
  botToken: string;
  approvalChannelId: string;
  activityChannelId: string;
  alertChannelId: string;
  environment: "staging" | "production";
};

export async function sendDiscordForecastRoutingSmoke(
  input: RoutingSmokeInput,
  fetcher: typeof fetch = fetch,
) {
  validateInput(input);
  const messages = [
    {
      kind: "approval",
      channelId: input.approvalChannelId,
      title: "Forecast 승인 채널 확인",
      description: "관리자 확인과 승인 버튼이 필요한 메시지는 이 채널로 전달됩니다.",
      color: 0x9b59b6,
    },
    {
      kind: "activity",
      channelId: input.activityChannelId,
      title: "Forecast 진행 채널 확인",
      description: "수집, workflow dispatch, canary와 배포 진행 메시지는 이 채널로 전달됩니다.",
      color: 0x3498db,
    },
    {
      kind: "alert",
      channelId: input.alertChannelId,
      title: "Forecast 오류 채널 확인",
      description: "운영 경고, 오류와 복구 메시지는 이 채널로 전달됩니다.",
      color: 0xf1c40f,
    },
  ] as const;
  const results: Array<{ kind: string; channelId: string; messageId: string }> = [];
  for (const message of messages) {
    const response = await fetcher(`${DISCORD_API}/channels/${message.channelId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bot ${input.botToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title: `[${input.environment} smoke] ${message.title}`,
            description: message.description,
            color: message.color,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`discord_routing_smoke_${message.kind}_${response.status}`);
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body["id"] !== "string" || !/^\d{6,24}$/.test(body["id"])) {
      throw new Error(`discord_routing_smoke_${message.kind}_response_invalid`);
    }
    results.push({ kind: message.kind, channelId: message.channelId, messageId: body["id"] });
  }
  return results;
}

async function main() {
  const results = await sendDiscordForecastRoutingSmoke({
    botToken: requiredEnvironment("DISCORD_BOT_TOKEN"),
    approvalChannelId: requiredEnvironment("DISCORD_APPROVAL_CHANNEL_ID"),
    activityChannelId: requiredEnvironment("DISCORD_ACTIVITY_CHANNEL_ID"),
    alertChannelId: requiredEnvironment("DISCORD_ALERT_CHANNEL_ID"),
    environment: readEnvironment(),
  });
  console.log(
    JSON.stringify({
      event: "discord_forecast_routing_smoke",
      messages: results.map(({ kind, channelId, messageId }) => ({ kind, channelId, messageId })),
    }),
  );
}

function validateInput(input: RoutingSmokeInput) {
  if (!input.botToken) throw new Error("discord_bot_token_missing");
  for (const [name, value] of Object.entries({
    approval: input.approvalChannelId,
    activity: input.activityChannelId,
    alert: input.alertChannelId,
  })) {
    if (!/^\d{6,24}$/.test(value)) throw new Error(`discord_${name}_channel_id_invalid`);
  }
  if (
    new Set([input.approvalChannelId, input.activityChannelId, input.alertChannelId]).size !== 3
  ) {
    throw new Error("discord_routing_channels_must_be_distinct");
  }
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function readEnvironment() {
  const value = requiredEnvironment("FORECAST_ENVIRONMENT");
  if (value !== "staging" && value !== "production") {
    throw new Error("Invalid FORECAST_ENVIRONMENT.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
