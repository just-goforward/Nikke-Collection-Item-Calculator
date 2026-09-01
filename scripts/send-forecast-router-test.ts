import { randomBytes } from "node:crypto";

const token = requiredEnvironment("DISCORD_BOT_TOKEN");
const channelId = requiredEnvironment("DISCORD_ACTIVITY_CHANNEL_ID");
if (!/^\d{6,24}$/.test(channelId)) throw new Error("discord_activity_channel_id_invalid");
const customId = `forecast_router_test:${randomBytes(16).toString("hex")}`;
const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
  method: "POST",
  headers: {
    authorization: `Bot ${token}`,
    "content-type": "application/json",
    "user-agent":
      "DiscordBot (https://github.com/just-goforward/Nikke-Collection-Item-Calculator, 1.0)",
  },
  body: JSON.stringify({
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: "Forecast Interaction Router 확인",
        description:
          "새 Router의 Discord 서명, 승인자 권한, 3초 이내 deferred 응답만 확인합니다. Forecast, PR, queue는 변경하지 않습니다.",
        color: 0x3498db,
      },
    ],
    components: [
      {
        type: 1,
        components: [{ type: 2, style: 1, custom_id: customId, label: "Router 응답 테스트" }],
      },
    ],
  }),
  signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error(`discord_router_test_message_${response.status}`);
const body = (await response.json()) as unknown;
if (!isRecord(body) || typeof body["id"] !== "string") {
  throw new Error("discord_router_test_message_id_missing");
}
console.log(`Router test card sent: message ${body["id"]}, custom ID ${customId}`);

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
