import { describe, expect, it } from "vitest";
import type { ScheduleEvent } from "./types";
import { classifyOfficialXPosts } from "./x-probe";

const target: ScheduleEvent = {
  eventId: "naver-board-56:1:solo",
  eventType: "solo",
  sourceItem: {
    source: "naver-board-56",
    itemId: "1",
    url: "https://game.naver.com/lounge/nikke/board/detail/1",
    title: "솔로 레이드",
    excerpt: "8월 20일 12:00 ~ 8월 27일 4:59",
    normalizedText: "솔로 레이드 8월 20일 12:00 ~ 8월 27일 4:59",
    publishedAt: "2026-08-18T03:00:00.000Z",
    contentHash: "a".repeat(64),
    structured: true,
    official: true,
  },
  startsAt: "2026-08-20T03:00:00.000Z",
  endsAt: "2026-08-26T19:59:00.000Z",
  scheduleStatus: "confirmed",
  manualReview: false,
  reason: null,
};

describe("X public timeline classification", () => {
  it("treats a login wall or unreadable empty timeline as unavailable", async () => {
    await expect(classifyOfficialXPosts([], target)).resolves.toEqual({
      status: "x_unavailable",
      sourceItem: null,
      reason: "no_readable_public_posts",
    });
  });

  it("cross-checks a matching official status ID and blocks a conflicting date", async () => {
    const matching = await classifyOfficialXPosts(
      [
        {
          text: "솔로 레이드 8월 20일 12:00 ~ 8월 27일 4:59",
          href: "https://x.com/NIKKE_kr/status/1234567890",
          publishedAt: "2026-08-18T03:00:00.000Z",
        },
      ],
      target,
    );
    const conflict = await classifyOfficialXPosts(
      [
        {
          text: "솔로 레이드 8월 21일 12:00 ~ 8월 28일 4:59",
          href: "https://x.com/NIKKE_kr/status/1234567891",
          publishedAt: "2026-08-18T03:00:00.000Z",
        },
      ],
      target,
    );

    expect(matching).toMatchObject({
      status: "crosschecked",
      sourceItem: { itemId: "1234567890", source: "x-nikke-kr" },
    });
    expect(conflict).toMatchObject({
      status: "conflict",
      sourceItem: { itemId: "1234567891" },
      reason: "official_sources_report_different_start_dates",
    });
  });
});
