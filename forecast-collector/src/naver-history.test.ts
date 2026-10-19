import { describe, expect, it } from "vitest";
import changeFixture from "../fixtures/naver-board-48-change.json?raw";
import soloFixture from "../fixtures/naver-board-56-solo.json?raw";
import { parseKoreanDateRange, parseNaverFeed, parseScheduleEvents } from "./naver";

describe("historical Naver notice interpretation", () => {
  it("requires solo and change words in the same sentence for unnumbered notices", async () => {
    const [item] = await parseNaverFeed(JSON.parse(soloFixture) as unknown, 56);
    if (!item) throw new Error("missing solo fixture");
    const [unrelated] = await parseScheduleEvents([
      {
        ...item,
        normalizedText: "솔로 레이드 8/20 12:00 ~ 8/27 4:59. 협동 작전 연장 안내.",
      },
    ]);
    const [changed] = await parseScheduleEvents([
      {
        ...item,
        normalizedText: "솔로 레이드 연장 안내. 8/20 12:00 ~ 8/27 4:59.",
      },
    ]);
    expect(unrelated?.eventType).toBe("solo");
    expect(unrelated?.manualReview).toBe(false);
    expect(changed?.eventType).toBe("schedule_change");
  });

  it("extracts an official structured Solo Raid schedule", async () => {
    const items = await parseNaverFeed(JSON.parse(soloFixture), 56);
    const events = await parseScheduleEvents(items);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: "naver-board-56",
      itemId: "8060044",
      official: true,
      structured: true,
    });
    expect(events[0]).toMatchObject({
      eventType: "solo",
      startsAt: "2026-08-20T03:00:00.000Z",
      endsAt: "2026-08-26T19:59:00.000Z",
      manualReview: false,
    });
  });

  it("recognizes the SmartEditor HTML envelope as structured content", async () => {
    const payload = {
      code: 200,
      content: {
        feeds: [
          {
            feed: {
              feedId: 8060044,
              title: "솔로 레이드 오픈 예정",
              createdDate: "20260814170042",
              contents: `
                <div class="se-viewer se-theme-default" lang="ko-KR">
                  <!-- SE_DOC_HEADER_START --><!--@CONTENTS_HEADER--><!-- SE_DOC_HEADER_END -->
                  <div class="se-main-container">
                    <p class="se-text-paragraph"><span>솔로 레이드 시즌 40</span></p>
                    <p class="se-text-paragraph"><span>진행 기간 - 8/20(목) 12:00 ~ 8/27(목) 4:59</span></p>
                  </div>
                </div>`,
            },
            user: { userRoleCode: "game_manager" },
            feedLink: { pc: "https://game.naver.com/lounge/nikke/board/detail/8060044" },
          },
        ],
      },
    };
    const items = await parseNaverFeed(payload, 56);
    const events = await parseScheduleEvents(items);
    expect(items[0]).toMatchObject({ structured: true, official: true });
    expect(events[0]).toMatchObject({
      startsAt: "2026-08-20T03:00:00.000Z",
      endsAt: "2026-08-26T19:59:00.000Z",
      manualReview: false,
    });
  });

  it("does not treat script or style contents as unstructured source evidence", async () => {
    const payload = {
      code: 200,
      content: {
        feeds: [
          {
            feed: {
              feedId: 999,
              title: "일반 공지",
              createdDate: "20260814170042",
              contents: `
                <html><body>
                  <script>솔로 레이드 8/20 12:00 ~ 8/27 4:59</script data-source="x">
                  <style>.솔로레이드 { color: red; }</style>
                  <p>관련 일정이 없는 본문</p>
                </body></html>`,
            },
            user: { userRoleCode: "game_manager" },
          },
        ],
      },
    };
    await expect(parseNaverFeed(payload, 56)).resolves.toEqual([]);
  });

  it("preserves ambiguous schedule-change history", async () => {
    const events = await parseScheduleEvents(await parseNaverFeed(JSON.parse(changeFixture), 48));
    expect(events[0]).toMatchObject({
      eventType: "schedule_change",
      startsAt: null,
      endsAt: null,
      manualReview: true,
      reason: "ambiguous_schedule_change",
    });
  });

  it("handles a date range crossing a calendar year", () => {
    expect(
      parseKoreanDateRange("12월 29일 12:00 ~ 1월 5일 4:59", "2026-12-20T03:00:00.000Z"),
    ).toEqual({
      start: "2026-12-29T03:00:00.000Z",
      end: "2027-01-04T19:59:00.000Z",
    });
  });
});
