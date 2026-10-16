import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forecastDisplayText } from "../../shared/forecastDisplayText.ts";
import { manualReviewPostLink, manualReviewReason } from "../../shared/forecastManualReview.ts";
import {
  dispatchAcceptedMessage,
  opsAlertMessage,
  opsRecoveryMessage,
  resolveDiscordChannelId,
  sendDiscordMessage,
} from "./discord";
import type { DispatcherEnv, OpsAlertRow } from "./types";

const deniedFetch = vi.fn(async () => {
  throw new Error("Unexpected outbound fetch in Discord message tests.");
});

beforeEach(() => {
  deniedFetch.mockClear();
  vi.stubGlobal("fetch", deniedFetch);
});

afterEach(() => {
  try {
    expect(deniedFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("Discord forecast operations messages", () => {
  it("normalizes titles only for display and links the escaped title", async () => {
    const title = "&#x1f4e2;\u200b [일정] &amp; 안내";
    expect(forecastDisplayText(title)).toBe("📢 [일정] & 안내");
    expect(forecastDisplayText("&#128226;&quot;&apos;&nbsp;&#x110000;")).toBe("📢\"' ");
    const alert = {
      ...alertRow(),
      alertKey: "manual-review:example",
      context: {
        reviewId: `mr-${"a".repeat(32)}`,
        title,
        url: "https://game.naver.com/lounge/nikke/board/detail/123",
      },
    };
    const message = await opsAlertMessage(alert);
    expect(message.embeds[0]?.description).toContain(
      "[📢 [일정] & 안내](https://game.naver.com/lounge/nikke/board/detail/123)",
    );
    const link = (value: string) =>
      manualReviewPostLink(value, "https://game.naver.com/lounge/nikke/board/detail/1");
    // Real board titles keep their brackets and parentheses without backslashes.
    expect(link("[점검 완료][점검&업데이트] 8월 13일(목) 안내(8/20 내용 추가)")).toBe(
      "[[점검 완료][점검&업데이트] 8월 13일(목) 안내(8/20 내용 추가)](https://game.naver.com/lounge/nikke/board/detail/1)",
    );
    // Unbalanced brackets or a nested-link attempt cannot close the label early.
    expect(link("a] [b [c](https://evil.example) *d*")).toBe(
      "[a］ ［b ［c］(https://evil.example) \\*d\\*](https://game.naver.com/lounge/nikke/board/detail/1)",
    );
    expect(JSON.stringify(message)).not.toContain("원문 열기");
    expect(JSON.stringify(message)).toContain("일정 직접 확정");
    expect(alert.context.title).toBe(title);
  });
});

describe("Discord manual-review reasons", () => {
  it("explains manual-review reasons in plain Korean and keeps the code secondary", async () => {
    const message = (await opsAlertMessage({
      ...alertRow(),
      alertKey: "manual-review:example",
      context: {
        reviewId: `mr-${"a".repeat(32)}`,
        title: "공지",
        url: "https://game.naver.com/lounge/nikke/board/detail/123",
        reason: "ambiguous_schedule_change",
      },
    })) as { embeds: { description: string }[] };
    const [, reason, meta] = message.embeds[0]!.description.split("\n");
    expect(reason).toBe("사유: 공지에서 일정 변경 여부를 자동으로 판단하지 못했습니다.");
    expect(meta).toContain("`ambiguous_schedule_change`");
    expect(manualReviewReason("naver_http_404")).toContain("삭제·비공개");
    expect(manualReviewReason("naver_detail_schema_code")).toContain("구조");
    expect(manualReviewReason("naver_timeout")).toContain("반복해서 실패");
    expect(manualReviewReason("naver_http_429")).toContain("반복해서 실패");
    expect(manualReviewReason("something_new")).toBe(
      "자동 처리에 실패해 사람의 확인이 필요합니다.",
    );
  });
});

describe("Discord forecast operations message identity", () => {
  it("uses the complete alert identity instead of a shared sanitized prefix", async () => {
    const alert = alertRow();
    const first = await opsAlertMessage(alert);
    const otherKey = await opsAlertMessage({
      ...alert,
      alertKey: "dispatch-stale:staging:fd-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    const punctuation = await opsAlertMessage({
      ...alert,
      alertKey: alert.alertKey.replaceAll(":", "-"),
    });

    expect(first.nonce).toMatch(/^[0-9a-f]{25}$/);
    expect(first.nonce).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([
            "forecast-ops-v1",
            "staging",
            "dispatch-stale:staging:fd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "2026-09-01T00:00:00.000Z",
            "alert",
            1,
            null,
          ]),
        )
        .digest("hex")
        .slice(0, 25),
    );
    expect(otherKey.nonce).not.toBe(first.nonce);
    expect(punctuation.nonce).not.toBe(first.nonce);
    expect((await opsAlertMessage(alert)).nonce).toBe(first.nonce);
    expect(first).toMatchObject({
      enforce_nonce: true,
      allowed_mentions: { parse: [] },
    });
  });

  it("separates environments, recurrence identities, occurrence counts, and recoveries", async () => {
    const alert = alertRow();
    const first = await opsAlertMessage(alert);
    const variants = [
      { ...alert, environment: "production" as const },
      { ...alert, firstSeenAt: "2026-09-01T00:00:00.001Z" },
      { ...alert, occurrenceCount: 2 },
    ];
    for (const variant of variants) {
      expect((await opsAlertMessage(variant)).nonce).not.toBe(first.nonce);
    }
    const resolved = {
      ...alert,
      state: "resolved" as const,
      resolvedAt: "2026-09-01T00:01:00.000Z",
    };
    const recovery = await opsRecoveryMessage(resolved);
    expect(recovery.nonce).not.toBe(first.nonce);
    expect((await opsRecoveryMessage(resolved)).nonce).toBe(recovery.nonce);
    expect(
      (await opsRecoveryMessage({ ...resolved, resolvedAt: "2026-09-01T00:02:00.000Z" })).nonce,
    ).not.toBe(recovery.nonce);
    expect(recovery).toMatchObject({
      enforce_nonce: true,
      allowed_mentions: { parse: [] },
    });
  });

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
    expect(sentBody.embeds[0]?.description).toContain("@\u200beveryone");
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

function alertRow(): OpsAlertRow {
  return {
    alertKey: "dispatch-stale:staging:fd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    environment: "staging",
    severity: "critical",
    component: "github-workflow",
    errorCode: "dispatch_work_remaining_20_minutes",
    state: "open",
    context: {},
    occurrenceCount: 1,
    lastSentOccurrenceCount: 0,
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    resolvedAt: null,
  };
}

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
