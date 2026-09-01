import { describe, expect, it, vi } from "vitest";
import { dispatchAcceptedMessage, resolveDiscordChannelId, sendDiscordMessage } from "./discord";
import type { DispatcherEnv } from "./types";

describe("Discord forecast operations messages", () => {
  it("returns the rate-limit delay without sleeping or retrying", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ retry_after: 65 }, { status: 429 }));
    const payload = dispatchAcceptedMessage(env(), {
      dispatchId: `fd-${"a".repeat(32)}`,
      mode: "work",
      fingerprint: "b".repeat(64),
      pendingCount: 1,
      candidateCount: 0,
      attempt: 1,
      links: [
        {
          source: "naver-board-56",
          itemId: "123",
          title: "@everyone 솔로 레이드 안내",
          url: "https://game.naver.com/lounge/nikke/board/detail/123",
        },
      ],
    });

    await expect(
      sendDiscordMessage(env(), "activity", payload, { fetchImpl }),
    ).rejects.toMatchObject({
      message: "discord_create_message_429",
      retryable: true,
      retryAfterMs: 65_000,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const sentBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      allowed_mentions: { parse: string[] };
      embeds: Array<{ description: string }>;
    };
    expect(sentBody.allowed_mentions).toEqual({ parse: [] });
    expect(sentBody.embeds[0]?.description).toContain("\\@everyone");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/channels/222222222222222222/messages");
  });

  it("routes alerts separately and falls back to the legacy channel when needed", () => {
    expect(resolveDiscordChannelId(env(), "alert")).toBe("333333333333333333");
    expect(
      resolveDiscordChannelId(
        {
          ...env(),
          DISCORD_ACTIVITY_CHANNEL_ID: "invalid",
          DISCORD_FALLBACK_CHANNEL_ID: "444444444444444444",
        },
        "activity",
      ),
    ).toBe("444444444444444444");
    expect(
      resolveDiscordChannelId(
        {
          ...env(),
          DISCORD_ACTIVITY_CHANNEL_ID: "invalid",
          DISCORD_FALLBACK_CHANNEL_ID: "invalid",
        },
        "activity",
      ),
    ).toBe("123456789012345678");
  });

  it("does not retry a Discord permission failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    const error = await sendDiscordMessage(
      env(),
      "alert",
      { allowed_mentions: { parse: [] } },
      { fetchImpl },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "discord_create_message_403", retryable: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns a typed retryable server failure without sleeping", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const error = await sendDiscordMessage(
      env(),
      "alert",
      { allowed_mentions: { parse: [] } },
      { fetchImpl },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "discord_create_message_500", retryable: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

function env() {
  return {
    ENVIRONMENT: "staging",
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_CHANNEL_ID: "123456789012345678",
    DISCORD_ACTIVITY_CHANNEL_ID: "222222222222222222",
    DISCORD_ALERT_CHANNEL_ID: "333333333333333333",
    DISCORD_FALLBACK_CHANNEL_ID: "123456789012345678",
  } as DispatcherEnv;
}
