import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manualReviewPostLink } from "../../shared/forecastManualReview.ts";
import {
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
    vi.restoreAllMocks();
  }
});

describe("Discord forecast operations messages", () => {
  it("links the escaped title and leaves the stored title untouched", async () => {
    const title = "&#x1f4e2;\u200b [일정] &amp; 안내";
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
    expect(message).not.toHaveProperty("components");
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
    expect(JSON.stringify(message)).not.toContain("forecast_manual_");
    expect(JSON.stringify(message)).not.toContain("일정 직접 확정");
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
    expect(message).not.toHaveProperty("components");
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
    const payload = await opsAlertMessage({
      ...alertRow(),
      context: { title: "@everyone 솔로 레이드 안내" },
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
    expect(sentBody.embeds[0]?.description).toContain("@everyone");
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

  it("reports an unreadable retry delay and keeps the durable fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not json", { status: 429 }));
    const error = await sendDiscordMessage(
      env(),
      "alert",
      { allowed_mentions: { parse: [] } },
      { fetchImpl },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ retryAfterMs: 5 * 60 * 1_000 });
    expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toMatchObject({
      event: "discord_retry_after_fallback",
      code: "retry_after_unreadable",
      status: 429,
    });
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

describe("Discord budget incident messages", () => {
  const incident = (kind: "metadata" | "detail", context: OpsAlertRow["context"] = {}) => ({
    ...alertRow(),
    alertKey: `forecast-v2:staging:budget:${kind}:2026-10-18`,
    severity: "warning" as const,
    component: "collector",
    errorCode: "budget_exhausted",
    context: context,
  });

  it("renders the metadata guidance with used/limit, streams and the 05:00 KST reset", async () => {
    const message = (await opsAlertMessage(
      incident("metadata", {
        gameDay: "2026-10-18",
        kind: "metadata",
        used: 240,
        limit: 240,
        resetAt: "2026-10-18T20:00:00.000Z",
        affectedStreams: "A,B,C-open",
      }),
    )) as { description?: string; embeds: { description: string }[] };
    expect(message).not.toHaveProperty("components");
    expect(message).toMatchObject({ allowed_mentions: { parse: [] } });
    expect(message.embeds[0]?.description).toBe(
      [
        "**Forecast 공지 수집 일시 대기** · 환경: staging",
        "❌ 무슨 일이: 오늘 공지 목록 조회 한도 240/240회를 모두 사용했습니다. 승인 오류가 아니라 Naver 요청량을 제한하는 보호 장치입니다.",
        "📌 영향: 다음 한도가 적용될 때까지 새 공지·수정 공지 확인이 멈춥니다(감시: A, B, C-open). 이미 저장된 내용의 승인 처리는 계속됩니다.",
        "🕔 자동 재개: 10/19(월) 05:00 KST에 새 한도가 적용되고 다음 수집 차례에 자동으로 다시 확인합니다.",
        "👉 해 주실 일: 할 일 없음. 이 경고 때문에 승인을 다시 누르지 마세요. 매일 반복되면 운영자가 요청량을 점검해야 합니다.",
      ].join("\n"),
    );
  });

  it("renders the detail guidance with its own impact line", async () => {
    const message = (await opsAlertMessage(
      incident("detail", {
        gameDay: "2026-10-18",
        kind: "detail",
        used: 48,
        limit: 48,
        resetAt: "2026-10-18T20:00:00.000Z",
        affectedStreams: "D",
      }),
    )) as { embeds: { description: string }[] };
    expect(message.embeds[0]?.description).toBe(
      [
        "**Forecast 공지 수집 일시 대기** · 환경: staging",
        "❌ 무슨 일이: 오늘 공지 본문 조회 한도 48/48회를 모두 사용했습니다. 승인 오류가 아니라 Naver 요청량을 제한하는 보호 장치입니다.",
        "📌 영향: 새 공지 본문 확인과 자동 판정이 다음 한도까지 늦어집니다. 본문을 기다리는 감시는 목록 확인도 함께 늦어질 수 있습니다(감시: D). 이미 저장된 내용의 승인 처리는 계속됩니다.",
        "🕔 자동 재개: 10/19(월) 05:00 KST에 새 한도가 적용되고 다음 수집 차례에 자동으로 다시 확인합니다.",
        "👉 해 주실 일: 할 일 없음. 이 경고 때문에 승인을 다시 누르지 마세요. 매일 반복되면 운영자가 요청량을 점검해야 합니다.",
      ].join("\n"),
    );
  });

  it("keeps the nonce stable across later holds of the same incident", async () => {
    const base = incident("metadata", { used: 240, limit: 240, affectedStreams: "A" });
    const first = await opsAlertMessage(base);
    const later = await opsAlertMessage({
      ...base,
      occurrenceCount: 27,
      lastSentOccurrenceCount: 1,
      context: { ...base.context, affectedStreams: "A,B" },
    });
    expect(later.nonce).toBe(first.nonce);
    expect((await opsAlertMessage({ ...base, alertKey: `${base.alertKey}` })).nonce).toBe(
      first.nonce,
    );
    expect(
      (await opsAlertMessage({ ...base, alertKey: "forecast-v2:staging:budget:detail:2026-10-18" }))
        .nonce,
    ).not.toBe(first.nonce);
    expect((await opsAlertMessage({ ...base, environment: "production" })).nonce).not.toBe(
      first.nonce,
    );
    // Ordinary alert nonces still move with the occurrence count.
    const ordinary = alertRow();
    expect((await opsAlertMessage({ ...ordinary, occurrenceCount: 2 })).nonce).not.toBe(
      (await opsAlertMessage(ordinary)).nonce,
    );
  });

  it("never invents numbers or a reset time for legacy contexts", async () => {
    const message = (await opsAlertMessage(incident("metadata"))) as {
      embeds: { description: string }[];
    };
    const description = message.embeds[0]?.description ?? "";
    expect(description).toContain("오늘 공지 목록 조회 한도를 모두 사용했습니다.");
    expect(description).not.toMatch(/\d+\/\d+회/);
    expect(description).toContain("(감시: 전체 스트림)");
    // The game day in the key still gives an exact reset instant.
    expect(description).toContain("10/19(월) 05:00 KST");
  });

  it("keeps generic operations alerts on the existing layout", async () => {
    const message = (await opsAlertMessage(alertRow())) as {
      embeds: { title: string; description: string }[];
    };
    expect(message.embeds[0]?.title).toBe("Forecast 운영 오류");
    expect(message.embeds[0]?.description).toContain(
      "오류 코드: `dispatch_work_remaining_20_minutes`",
    );
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
