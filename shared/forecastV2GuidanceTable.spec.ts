import { describe, expect, it } from "vitest";
import { renderForecastV2Notification } from "./forecastV2Notifications.ts";
import { buttonsOf, context, description, request, solo } from "./forecastV2TestFixtures.ts";

describe("v2 reason guidance", () => {
  it.each([
    [
      "maintenance_multiple",
      { type: "maintenance", options: [{ id: "ignore", label: "관련 없음" }] },
      "같은 날짜에 점검이 여러 건 있어 적용할 점검 종료 시각을 고르지 못했습니다.",
      "어느 점검 시간이 맞는지 확인한 뒤 [일정 수정]으로 시작·종료를 직접 입력해 주세요. 달력의 중복 점검도 함께 확인해 주세요.",
    ],
    [
      "grant_date_precision",
      { type: "grant_date", options: [{ id: "date_0", label: "2026-10-23" }] },
      "지급일의 시각(정밀도)을 확인하지 못했습니다.",
      "공지의 지급일·시각을 확인해 아래 버튼에서 맞는 지급일을 골라 주세요.",
    ],
    [
      "grant_quantity",
      {
        type: "grant_quantity",
        options: [
          { id: "separate", label: "별도 지급" },
          { id: "correction", label: "정정" },
        ],
      },
      "같은 날 지급 수량이 이미 달력에 있는 값과 달라 별도 지급인지 정정인지 확인이 필요합니다.",
      "별도로 더 지급된 것이면 [별도 지급], 기존 수량을 고치는 것이면 [정정].",
    ],
    [
      "collaboration_start_unresolved",
      { type: "collaboration", options: [{ id: "ignore", label: "관련 없음" }] },
      "콜라보 시작 시각('점검 완료 후' 등)을 확정하지 못했습니다.",
      "아래 버튼에 맞는 시작 일정이 있으면 고르고, 없으면 [일정 수정]으로 시작·종료를 직접 입력해 주세요.",
    ],
    [
      "maintenance_conflict",
      { type: "maintenance", options: [{ id: "ignore", label: "기존 점검 유지" }] },
      "같은 날짜에 이미 다른 점검 일정이 있어 어느 점검 시간을 달력에 남길지 확인이 필요합니다.",
      "이 공지의 점검 시간을 적용할지 기존 점검을 유지할지 버튼으로 고르고, 둘 다 아니면 [일정 수정]으로 직접 입력해 주세요.",
    ],
  ])("explains %s with the matching guidance", (reason, extra, blocked, todo) => {
    const message = renderForecastV2Notification(
      "decision_request",
      { ...request, reason, ...extra },
      context,
    );
    expect(description(message)).toContain(`❌ 막힌 이유: ${blocked}`);
    expect(description(message)).toContain(`👉 해 주실 일: ${todo}`);
  });

  it("renders legacy payloads without the new fields through a sensible fallback", () => {
    const message = renderForecastV2Notification(
      "decision_request",
      {
        decisionRequestId: "one",
        type: "solo_review",
        feedIds: [1],
        title: "공지",
        url: request.url,
        options: [],
        expiresAt: "2026-11-05T03:12:00Z",
      },
      context,
    );
    expect(description(message).split("\n").slice(1, 3)).toEqual([
      "하려던 일: 솔로 레이드 일정 확정",
      "✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다",
    ]);
    expect(description(message)).toContain(
      "❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다",
    );
    expect(buttonsOf(message).map((b) => b.label)).toEqual(["일정 수정", "관련 없음"]);
  });

  it("keeps an unknown reason actionable instead of crashing", () => {
    const message = solo({ reason: "some_future_code" });
    expect(description(message)).toContain("❌ 막힌 이유: 자동 판단을 마치지 못했습니다.");
    expect(description(message)).toContain(
      "👉 해 주실 일: 공지 원문을 확인해 맞으면 [일정 수정]으로 시작·종료를 직접 입력하고, 무관하면 [관련 없음]을 눌러 주세요.",
    );
  });
});
