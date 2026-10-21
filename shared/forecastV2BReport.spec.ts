import { describe, expect, it } from "vitest";
import { renderForecastV2Notification } from "./forecastV2Notifications.ts";
import { buttonsOf, context, description, request } from "./forecastV2TestFixtures.ts";

describe("v2 B reports", () => {
  it("offers the B confirm only for a complete decision window", () => {
    const base = {
      feedId: 1,
      title: "중단",
      url: request.url,
      postedAt: request.expiresAt,
      decisionRequestId: "one",
      extracted: {
        segments: [{ kind: "suspend" as const, startAt: "2026-10-23T02:00:00Z" }],
        kits: [],
      },
    };
    const complete = renderForecastV2Notification(
      "b_report",
      {
        ...base,
        extracted: {
          segments: [
            {
              kind: "suspend" as const,
              startAt: "2026-10-23T02:00:00Z",
              endAt: "2026-10-23T07:00:00Z",
            },
          ],
          kits: [],
        },
        decision: {
          complete: true,
          startAt: "2026-10-23T02:00:00Z",
          endAt: "2026-10-23T07:00:00Z",
        },
      },
      context,
    );
    expect(buttonsOf(complete).map((b) => b.label)).toContain("이 일정으로 확정");
    expect(description(complete)).toContain(
      "🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 10/23(금) 16:00)으로 하면 될까요?",
    );
    // A complete flag without a usable window cannot back a confirm either.
    for (const decision of [
      { complete: false, startAt: "2026-10-23T02:00:00Z" },
      { complete: true },
      { complete: true, startAt: "2026-10-23T07:00:00Z", endAt: "2026-10-23T02:00:00Z" },
    ]) {
      const message = renderForecastV2Notification("b_report", { ...base, decision }, context);
      expect(buttonsOf(message).map((b) => b.label)).not.toContain("이 일정으로 확정");
      expect(description(message)).toContain("🤔 추측한 것: 읽은 구간: ");
      expect(description(message)).not.toContain("으로 하면 될까요?");
    }
  });

  it("keeps the guidance and expiry for a B report with dozens of segments", () => {
    const segments = Array.from({ length: 60 }, (_, index) => ({
      kind: "suspend" as const,
      startAt: `2026-10-${String((index % 28) + 1).padStart(2, "0")}T02:00:00Z`,
      endAt: `2026-10-${String((index % 28) + 1).padStart(2, "0")}T07:00:00Z`,
    }));
    const message = renderForecastV2Notification(
      "b_report",
      {
        feedId: 1,
        title: "중단",
        url: request.url,
        postedAt: request.expiresAt,
        decisionRequestId: "one",
        extracted: { segments, kits: [] },
        // No complete decision window: the 읽은 구간 line is built from every segment.
        decision: {
          complete: false,
          startAt: "2026-10-23T02:00:00Z",
          endAt: "2026-10-23T07:00:00Z",
        },
      },
      context,
    );
    const text = description(message);
    // A B report carries no expiry, so the sections it does have must all survive.
    for (const section of [
      "🔎",
      "하려던 일:",
      "✅ 확인한 것:",
      "🤔 추측한 것:",
      "❌ 막힌 이유:",
      "👉 해 주실 일:",
    ])
      expect(text).toContain(section);
    expect(text).toContain("B 게시판 공지는 근거 자료일 뿐이라 자동으로 확정하지 않았습니다.");
    expect(text).toContain("[일정 수정]으로 시작·종료를 직접 입력");
    // The 읽은 구간 line is one bounded item, never a 60-segment wall of text.
    const guessLine = text.split("\n").find((line) => line.startsWith("🤔 추측한 것:"));
    expect(guessLine?.length).toBeLessThanOrEqual("🤔 추측한 것: ".length + 160);
    // Nothing was cut by the final cap: the message fits the budget with room to spare.
    expect(text).not.toContain("…(생략)");
    expect(text.endsWith("[관련 없음].")).toBe(true);
  });

  it("asks the B confirm question only when the confirm button is rendered", () => {
    const base = {
      feedId: 1,
      title: "중단",
      url: request.url,
      postedAt: request.expiresAt,
      decisionRequestId: "one",
      extracted: {
        segments: [{ kind: "suspend" as const, startAt: "2026-10-23T02:00:00Z" }],
        kits: [],
      },
    };
    // A window without `complete` renders no [이 일정으로 확정]: no question either.
    const incomplete = renderForecastV2Notification(
      "b_report",
      {
        ...base,
        decision: {
          complete: false,
          startAt: "2026-10-23T02:00:00Z",
          endAt: "2026-10-23T07:00:00Z",
        },
      },
      context,
    );
    expect(buttonsOf(incomplete).map((b) => b.label)).not.toContain("이 일정으로 확정");
    expect(description(incomplete)).not.toContain("으로 하면 될까요?");
    expect(description(incomplete)).toContain("🤔 추측한 것: 읽은 구간: ");
    expect(
      description(incomplete)
        .split("\n")
        .find((line) => line.startsWith("👉 해 주실 일:")),
    ).toContain("[일정 수정]");
    // The complete window keeps both the button and the question.
    const complete = renderForecastV2Notification(
      "b_report",
      {
        ...base,
        decision: {
          complete: true,
          startAt: "2026-10-23T02:00:00Z",
          endAt: "2026-10-23T07:00:00Z",
        },
      },
      context,
    );
    expect(buttonsOf(complete).map((b) => b.label)).toContain("이 일정으로 확정");
    expect(description(complete)).toContain(
      "🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 10/23(금) 16:00)으로 하면 될까요?",
    );
  });
});
