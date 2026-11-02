import { describe, expect, it } from "vitest";
import type { ActiveCalendar } from "./calendar.ts";
import { renderCalendarPage } from "./render.ts";

describe("calendar presentation", () => {
  it("omits operational coverage and translates persisted decision terminology", () => {
    const calendar: ActiveCalendar = {
      version: 1,
      snapshotId: "test",
      updatedAt: "2026-10-18T10:00:00Z",
      createdAt: "2026-10-18T10:00:00Z",
      rangeStart: "2026-10-18",
      rangeEnd: "2026-11-18",
      events: new Map(),
      days: new Map([["2026-10-18", {
        gameDay: "2026-10-18",
        kits: { ii: 5, box: 0 },
        coop: 5,
        grants: [],
        eventIds: [],
        pending: ["coverage A: never committed", "coverage B last hold: none",
          "coverage C consecutive holds: 0", "결정 대기: maintenance",
          "expiresAt: 2026-10-19T00:00:00Z", "<script>"],
      }]]),
    };
    const page = renderCalendarPage({
      calendar, nowMs: Date.parse(calendar.createdAt), requestedRevision: null,
    });
    expect(page).not.toContain("coverage ");
    expect(page).toContain("결정 대기: 점검");
    expect(page).toContain("결정 기한:");
    expect(page).not.toContain("expiresAt:");
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("일일 파견 (추정)");
    expect(page).toContain("솔로 레이드 보상");
    expect(page).toContain("일일 파견 개별 관리 키트 예측값 (1일)");
    expect(page).not.toContain("https://discord.com/channels/");
    const id = "prediction_S43_primary";
    calendar.events.set(id, {
      eventId: id, revision: 1, kind: "solo", status: "predicted",
      startsAt: "2026-10-18T03:00:00Z", endsAt: null,
      startGameDay: "2026-10-18", endGameDay: null,
      afterMaintenance: false, provenance: null, title: "primary: predicted",
    });
    calendar.days.get("2026-10-18")!.eventIds.push(id);
    const translated = renderCalendarPage({ calendar, nowMs: Date.parse(calendar.createdAt), requestedRevision: null });
    expect(translated).toContain("솔로 레이드 43회 · 우선 예측");
    expect(translated).not.toContain("primary: predicted");
    const decision = { label: "maintenance", title: "점검 안내", sourceUrl: "https://example.com/notice",
      expiresAt: "2026-10-19T00:00:00Z", channelId: "333333333333333333", messageId: "222222222222222222" };
    calendar.decisions = [decision];
    calendar.days.get("2026-10-18")!.pending = ["결정 대기: maintenance", decision.title,
      decision.sourceUrl, `expiresAt: ${decision.expiresAt}`];
    const render = () => renderCalendarPage({ calendar, nowMs: Date.parse(calendar.createdAt),
      requestedRevision: null, discordGuildId: "111111111111111111" });
    expect(render()).toContain('<a class="badge" href="https://discord.com/channels/111111111111111111/333333333333333333/222222222222222222"');
    calendar.decisions.push({ ...decision, messageId: "444444444444444444" });
    expect(render()).not.toContain('<a class="badge"');
    expect(render()).toContain("요청 목록에서 확인");
  });
});
