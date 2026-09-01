import { describe, expect, it, vi } from "vitest";
import changeFixture from "../fixtures/naver-board-48-change.json?raw";
import soloFixture from "../fixtures/naver-board-56-solo.json?raw";
import {
  fetchNaverBoard,
  fetchNaverSoloHistory,
  fetchNaverStructuredItem,
  parseKoreanDateRange,
  parseNaverFeed,
  parseScheduleEvents,
} from "./naver";

describe("Naver Lounge parser", () => {
  it("extracts an official structured Solo Raid schedule", async () => {
    const payload = JSON.parse(soloFixture) as unknown;
    const items = await parseNaverFeed(payload, 56);
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

  it("recognizes the current SmartEditor HTML envelope as structured content", async () => {
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
            feedLink: {
              pc: "https://game.naver.com/lounge/nikke/board/detail/8060044",
            },
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

  it("does not auto-process an HTML envelope on the Actions JSON-only path", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        code: 200,
        content: {
          feed: {
            feedId: 8060044,
            title: "솔로 레이드 오픈 예정",
            createdDate: "20260814170042",
            contents: '<div class="se-main-container">솔로 레이드 8/20 12:00 ~ 8/27 4:59</div>',
          },
          user: { userRoleCode: "game_manager" },
        },
      }),
    );

    await expect(fetchNaverStructuredItem(56, "8060044", fetcher)).rejects.toThrow(
      "naver_unstructured_body",
    );
  });

  it("routes unstructured details to manual review even when only the body is relevant", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        code: 200,
        content: {
          feed: {
            feedId: 8060045,
            title: "8월 이벤트 안내",
            createdDate: "20260814170042",
            contents: '<div class="se-main-container">솔로 레이드 8/20 12:00 ~ 8/27 4:59</div>',
          },
          user: { userRoleCode: "game_manager" },
        },
      }),
    );

    await expect(fetchNaverStructuredItem(56, "8060045", fetcher)).rejects.toThrow(
      "naver_unstructured_body",
    );
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

  it("blocks an ambiguous schedule-change notice for manual review", async () => {
    const payload = JSON.parse(changeFixture) as unknown;
    const events = await parseScheduleEvents(await parseNaverFeed(payload, 48));

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

  it("retries one server failure and accepts the successful JSON response", async () => {
    const payload = soloFixture;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(payload, { headers: { "content-type": "application/json" } }),
      );

    await expect(fetchNaverBoard(56, fetcher)).resolves.toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const requestedUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requestedUrl.searchParams.get("limit")).toBe("30");
  });

  it("bootstraps only official Solo Raid opening details from title search", async () => {
    const fixture = JSON.parse(soloFixture) as {
      content: { feeds: Array<Record<string, unknown>> };
    };
    const detail = fixture.content.feeds[0];
    if (!detail) throw new Error("Solo fixture is empty.");
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/search/feeds")) {
        return Response.json({
          code: 200,
          content: {
            feeds: [
              {
                feedId: 8060044,
                title: "솔로 레이드 오픈 안내",
                board: { boardId: 56 },
                user: { userRoleCode: "game_manager" },
              },
              {
                feedId: 7877359,
                title: "솔로 레이드 재오픈 안내",
                board: { boardId: 56 },
                user: { userRoleCode: "game_manager" },
              },
            ],
          },
        });
      }
      return Response.json({
        code: 200,
        content: {
          ...detail,
          user: { userRoleCode: "game_manager" },
        },
      });
    });

    const items = await fetchNaverSoloHistory(fetcher);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ itemId: "8060044", official: true, structured: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects oversized and malformed responses without producing an empty success", async () => {
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "2000001" },
      }),
    );
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{", { headers: { "content-type": "application/json" } }));

    await expect(fetchNaverBoard(56, oversized)).rejects.toThrow("naver_response_oversize");
    await expect(fetchNaverBoard(56, malformed)).rejects.toThrow("naver_malformed_json");
  });

  it("retries one rate-limited response and then fails with the typed status", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("rate limited", { status: 429 }));

    await expect(fetchNaverBoard(56, fetcher)).rejects.toThrow("naver_http_429");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
