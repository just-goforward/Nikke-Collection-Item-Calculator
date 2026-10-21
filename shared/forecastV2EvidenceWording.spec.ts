import { describe, expect, it } from "vitest";
import { renderForecastV2Notification } from "./forecastV2Notifications.ts";
import { buttonsOf, context, description, request, solo } from "./forecastV2TestFixtures.ts";

describe("v2 evidence wording", () => {
  it("tells the approver nothing could be extracted and asks for manual input", () => {
    const message = solo({
      reason: "solo_period_unresolved",
      goal: "솔로 레이드 일정 확정",
      postedAt: "2026-10-22T02:00:00Z",
      confirmed: ["감지한 키워드: 솔로 레이드, 진행 기간"],
      guessed: [],
      extracted: { complete: false },
    });
    expect(description(message)).toBe(
      [
        "🔎 [@\u200beveryone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1) · 게시 10/22(목) 11:00",
        "하려던 일: 솔로 레이드 일정 확정",
        "✅ 확인한 것: 감지한 키워드: 솔로 레이드, 진행 기간",
        "🤔 추측한 것: 일정을 확인하지 못했습니다. [일정 수정]으로 직접 입력해 주세요.",
        "❌ 막힌 이유: 솔로 레이드 진행 기간(시작·종료)을 확정하지 못했습니다.",
        "👉 해 주실 일: 공지의 진행 기간을 확인해 [일정 수정]으로 시작·종료를 직접 입력해 주세요. 무관한 공지면 [관련 없음].",
        "만료 11/05(목) 12:12 KST",
      ].join("\n"),
    );
    expect(buttonsOf(message).map((b) => b.label)).toEqual(["일정 수정", "관련 없음"]);
  });

  it("asks explicitly about a complete guess even when the maintenance lookup failed", () => {
    const message = solo({
      reason: "maintenance_missing",
      goal: "솔로 레이드 일정 확정",
      confirmed: ["감지한 키워드: 솔로 레이드, 점검 완료 후"],
      guessed: ["10/23(금) 11:00 ~ 11/05(목) 04:59"],
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-11-04T19:59:59Z" },
      extracted: { complete: true },
    });
    expect(description(message)).toBe(
      [
        "🔎 [@\u200beveryone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)",
        "하려던 일: 솔로 레이드 일정 확정",
        "✅ 확인한 것: 감지한 키워드: 솔로 레이드, 점검 완료 후",
        "🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 11/05(목) 04:59)으로 하면 될까요?",
        "❌ 막힌 이유: 같은 날짜의 점검 일정을 찾지 못해 '점검 완료 후' 시각을 확정하지 못했습니다.",
        "👉 해 주실 일: 점검 일정을 확인해 주세요. 점검 공지가 아직 없다면 잠시 기다리고, 점검이 있는데 달력에 없다면 [일정 수정]으로 직접 입력해 주세요. 그 밖에 [이 일정으로 확정], [관련 없음] 버튼도 있습니다.",
        "만료 11/05(목) 12:12 KST",
      ].join("\n"),
    );
    expect(buttonsOf(message).map((b) => b.label)).toEqual([
      "이 일정으로 확정",
      "일정 수정",
      "관련 없음",
    ]);
  });

  it("labels option buttons in KST instead of raw ISO", () => {
    const message = renderForecastV2Notification(
      "decision_request",
      {
        ...request,
        type: "maintenance",
        options: [
          {
            id: "source_0",
            label: "기존 점검(2026-10-23 09:00:00 ~ 2026-10-23 12:00:00)에 이 공지 시간 적용",
          },
          { id: "window_0", label: "2026-10-23 11:00:00 ~ 2026-10-23 16:00:00 (KST)" },
          { id: "ignore", label: "기존 점검 유지" },
        ],
      },
      context,
    );
    expect(buttonsOf(message).map((b) => b.label)).toEqual([
      "기존 점검(10/23(금) 09:00 ~ 10/23(금) 12:00)에 이 공지 시간 적용",
      "10/23(금) 11:00 ~ 10/23(금) 16:00",
      "기존 점검 유지",
      "일정 수정",
    ]);
  });

  it("renders the reminder with the original post, goal and blocked reason", () => {
    const message = renderForecastV2Notification(
      "decision_reminder",
      {
        decisionRequestId: "one",
        title: "솔로 레이드 시즌 41",
        url: request.url,
        goal: "솔로 레이드 일정 확정",
        reason: "solo_period_unresolved",
        blocked: "진행 기간 줄을 찾지 못했습니다.",
        expiresAt: "2026-11-05T03:12:00Z",
      },
      context,
    );
    const lines = description(message).split("\n");
    expect(lines[0]).toContain(
      "🔎 [솔로 레이드 시즌 41](https://game.naver.com/lounge/nikke/board/detail/1)",
    );
    expect(lines).toContain("하려던 일: 솔로 레이드 일정 확정");
    expect(lines).toContain("❌ 막힌 이유: 진행 기간 줄을 찾지 못했습니다.");
    expect(lines.at(-1)).toBe("만료 11/05(목) 12:12 KST");
  });

  it("never shows a raw ISO instant in a rendered message", () => {
    const message = renderForecastV2Notification(
      "decision_request",
      {
        ...request,
        type: "maintenance",
        postedAt: "2026-10-22T02:00:00.000Z",
        guess: { startAt: "2026-10-23T02:00:00.000Z", endAt: "2026-10-23T07:00:00.000Z" },
      },
      context,
    );
    const text = `${description(message)} ${buttonsOf(message)
      .map((b) => b.label)
      .join(" ")}`;
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(description(message)).toContain("10/23(금) 11:00 ~ 10/23(금) 16:00");
  });
});
