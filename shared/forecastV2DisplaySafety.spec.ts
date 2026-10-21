import { describe, expect, it } from "vitest";
import { renderForecastV2Notification } from "./forecastV2Notifications.ts";
import { buttonsOf, context, description, request } from "./forecastV2TestFixtures.ts";

describe("v2 display safety", () => {
  it("escapes evidence as display text and keeps each section on one line", () => {
    const message = renderForecastV2Notification(
      "decision_request",
      {
        ...request,
        type: "solo_review",
        options: [],
        goal: "@everyone [확정](https://evil.example) **굵게**",
        confirmed: ["<@123> 줄1\n줄2", "`code` [링크](https://evil.example)"],
        blocked: "@here https://evil.example",
        todo: "<#456> **지금** 누르세요",
      },
      context,
    );
    const text = description(message);
    expect(text).not.toContain("@everyone");
    expect(text).not.toContain("@here");
    expect(text).not.toContain("<@123>");
    expect(text).not.toContain("<#456>");
    // No markdown link or bold can form out of evidence text.
    expect(text).not.toContain("](https://evil.example)");
    expect(text).not.toContain("**굵게**");
    expect(text).not.toContain("**지금**");
    // Injected newlines are collapsed so sections cannot be forged.
    expect(text).not.toContain("줄1\n줄2");
    expect(text).toContain("줄1 줄2");
    expect(text.split("\n").filter((line) => line.includes("하려던 일:"))).toHaveLength(1);
    expect(message.allowed_mentions).toEqual({ parse: [] });
  });

  it("keeps the legacy reminder neutral and never invents a reason", () => {
    const message = renderForecastV2Notification(
      "decision_reminder",
      {
        decisionRequestId: "one",
        type: "solo_review",
        title: "솔로 레이드 시즌 41",
        url: request.url,
        expiresAt: "2026-11-05T03:12:00Z",
      },
      context,
    );
    const lines = description(message).split("\n");
    expect(lines[1]).toBe("하려던 일: 솔로 레이드 일정 확정");
    expect(lines[2]).toBe("✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다");
    expect(lines[3]).toBe("🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다");
    expect(lines[4]).toBe("❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다");
    expect(description(message)).not.toContain("진행 기간(시작·종료)을 확정하지 못했습니다");
  });

  it("parses option labels with any offset sign and escapes unparsable ones", () => {
    const message = renderForecastV2Notification(
      "decision_request",
      {
        ...request,
        type: "maintenance",
        options: [
          { id: "a", label: "2026-10-23T02:00:00Z ~ 2026-10-23T07:00:00Z" },
          { id: "b", label: "2026-10-23T02:00:00-05:00 ~ 2026-10-23T07:00:00-05:00" },
          { id: "c", label: "2026-10-23T02:00:00+0530 ~ 2026-10-23T07:00:00+0530" },
          { id: "d", label: "[깨진 라벨](https://evil.example)" },
        ],
      },
      context,
    );
    expect(buttonsOf(message).map((b) => b.label)).toEqual([
      "10/23(금) 11:00 ~ 10/23(금) 16:00",
      "10/23(금) 16:00 ~ 10/23(금) 21:00",
      "10/23(금) 05:30 ~ 10/23(금) 10:30",
      "［깨진 라벨］(https://evil.example)",
      "일정 수정",
    ]);
  });
});
