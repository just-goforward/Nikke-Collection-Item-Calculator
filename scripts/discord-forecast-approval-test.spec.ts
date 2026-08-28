import { describe, expect, it, vi } from "vitest";
import {
  buildDiscordForecastApprovalTestMessage,
  sendDiscordForecastApprovalTest,
} from "./discord-forecast-approval-test";

const pullRequestUrl = "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/12";
const review = {
  version: 1 as const,
  candidateId: "forecast-discord-test-12345678",
  forecastId: "supply-2026-08-28-v1",
  x: {
    status: "unavailable" as const,
    source: "jina" as const,
    reason: "rate_limited" as const,
    statusUrl: null,
  },
  schedule: {
    status: "estimated" as const,
    soloStart: "2026-09-21T03:00:00.000Z",
    soloEnd: "2026-09-27T19:59:00.000Z",
    collaborationPeriods: [
      {
        effectiveFrom: "2026-08-19T20:00:00.000Z",
        effectiveUntil: "2026-09-09T19:59:00.000Z",
      },
    ],
  },
};

describe("Discord forecast approval test sender", () => {
  it("builds a mention-safe test-only approval card", () => {
    const message = buildDiscordForecastApprovalTestMessage(
      {
        approvalId: "discord-test-00000000-0000-4000-8000-000000000000",
        customId: "forecast_test_approve:discord-test-00000000-0000-4000-8000-000000000000",
        candidateId: review.candidateId,
        pullRequestUrl,
        expiresAt: "2026-08-27T00:30:00.000Z",
      },
      review,
    );

    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.content).toContain("https://x.com/NIKKE_kr");
    expect(message.content).toContain("솔로 레이드: 2026-09-21 12:00 KST");
    expect(message.content).not.toContain(review.candidateId);
    expect(message.components[0]?.components).toEqual([
      expect.objectContaining({ label: "확인 완료 (테스트)", style: 3 }),
      expect.objectContaining({ label: "GitHub PR 열기", style: 5, url: pullRequestUrl }),
    ]);
  });

  it("registers an immutable target before sending the Discord button", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          approvalId: "discord-test-00000000-0000-4000-8000-000000000000",
          customId: "forecast_test_approve:discord-test-00000000-0000-4000-8000-000000000000",
          candidateId: review.candidateId,
          pullRequestUrl,
          expiresAt: "2026-08-27T00:30:00.000Z",
        }),
      )
      .mockResolvedValueOnce(Response.json({ id: "555555555" }));

    const result = await sendDiscordForecastApprovalTest(
      {
        collectorUrl: "https://collector.example",
        collectorAdminToken: "collector-secret",
        discordBotToken: "discord-secret",
        discordChannelId: "333333333",
        review,
        pullRequestNumber: 12,
        pullRequestUrl,
        headSha: "c".repeat(40),
        runId: "1234",
        runAttempt: "1",
      },
      fetcher,
    );

    expect(result).toMatchObject({
      approvalId: "discord-test-00000000-0000-4000-8000-000000000000",
      messageId: "555555555",
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://collector.example/admin/discord-test-approvals",
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://discord.com/api/v10/channels/333333333/messages",
    );
    const discordInit = fetcher.mock.calls[1]?.[1];
    expect(new Headers(discordInit?.headers).get("authorization")).toBe("Bot discord-secret");
  });

  it("rejects a pull request URL outside the trusted repository", async () => {
    await expect(
      sendDiscordForecastApprovalTest(
        {
          collectorUrl: "https://collector.example",
          collectorAdminToken: "collector-secret",
          discordBotToken: "discord-secret",
          discordChannelId: "333333333",
          review,
          pullRequestNumber: 12,
          pullRequestUrl: "https://github.com/example/other/pull/12",
          headSha: "c".repeat(40),
          runId: "1234",
          runAttempt: "1",
        },
        vi.fn<typeof fetch>(),
      ),
    ).rejects.toThrow("Invalid pull request URL");
  });
});
