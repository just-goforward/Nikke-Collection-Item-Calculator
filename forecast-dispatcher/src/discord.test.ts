import { describe, expect, it, vi } from "vitest";
import { dispatchAcceptedMessage, sendDiscordMessage } from "./discord";
import type { DispatcherEnv } from "./types";

describe("Discord forecast operations messages", () => {
  it("retries one rate limit and always disables mentions", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ retry_after: 0.001 }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ id: "987654321098765432" }, { status: 200 }));
    const delay = vi.fn().mockResolvedValue(undefined);
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

    await expect(sendDiscordMessage(env(), payload, { fetchImpl, delay })).resolves.toEqual({
      messageId: "987654321098765432",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(250);
    const sentBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as {
      allowed_mentions: { parse: string[] };
      embeds: Array<{ description: string }>;
    };
    expect(sentBody.allowed_mentions).toEqual({ parse: [] });
    expect(sentBody.embeds[0]?.description).toContain("\\@everyone");
  });

  it("does not retry a Discord permission failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    const error = await sendDiscordMessage(
      env(),
      { allowed_mentions: { parse: [] } },
      { fetchImpl },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "discord_create_message_403", retryable: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries one Discord server failure and keeps the durable error typed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const delay = vi.fn().mockResolvedValue(undefined);
    const error = await sendDiscordMessage(
      env(),
      { allowed_mentions: { parse: [] } },
      { fetchImpl, delay },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "discord_create_message_500", retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(1_000);
  });
});

function env() {
  return {
    ENVIRONMENT: "staging",
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_CHANNEL_ID: "123456789012345678",
  } as DispatcherEnv;
}
