import { describe, expect, it, vi } from "vitest";
import changeFixture from "../fixtures/naver-board-48-change.json?raw";
import soloFixture from "../fixtures/naver-board-56-solo.json?raw";
import {
  fetchNaverBoard,
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

  it("fails a rate-limited response without retrying it as a server error", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("rate limited", { status: 429 }));

    await expect(fetchNaverBoard(56, fetcher)).rejects.toThrow("naver_http_429");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
