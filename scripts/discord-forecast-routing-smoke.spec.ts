import { describe, expect, it, vi } from "vitest";
import { sendDiscordForecastRoutingSmoke } from "./discord-forecast-routing-smoke";

describe("Discord forecast routing smoke", () => {
  it("sends one mention-free message to each distinct channel", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const index = fetcher.mock.calls.length;
      const body = JSON.parse(String(init?.body)) as { allowed_mentions: { parse: string[] } };
      expect(body.allowed_mentions).toEqual({ parse: [] });
      return Response.json({ id: `98765432109876543${index}` }, { status: 200 });
    });

    const result = await sendDiscordForecastRoutingSmoke(
      {
        botToken: "test-token",
        approvalChannelId: "111111111111111111",
        activityChannelId: "222222222222222222",
        alertChannelId: "333333333333333333",
        environment: "staging",
      },
      fetcher,
    );

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "https://discord.com/api/v10/channels/111111111111111111/messages",
      "https://discord.com/api/v10/channels/222222222222222222/messages",
      "https://discord.com/api/v10/channels/333333333333333333/messages",
    ]);
    expect(result.map(({ kind }) => kind)).toEqual(["approval", "activity", "alert"]);
  });

  it("rejects overlapping routing channels", async () => {
    await expect(
      sendDiscordForecastRoutingSmoke({
        botToken: "test-token",
        approvalChannelId: "111111111111111111",
        activityChannelId: "111111111111111111",
        alertChannelId: "333333333333333333",
        environment: "staging",
      }),
    ).rejects.toThrow("discord_routing_channels_must_be_distinct");
  });
});
