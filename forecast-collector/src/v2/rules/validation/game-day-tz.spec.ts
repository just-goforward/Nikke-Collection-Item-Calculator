import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { calendarRange, collaborationEnd, gameDay, gameDayEnd, gameDayStart } from "../game-day";
import { noticeDates } from "../notice-dates";
import { judgeSolo } from "../schedules";

// T01: every rule date is a 05:00 KST game day, whatever the process timezone is.
const originalTz = process.env["TZ"];
afterAll(() => {
  if (originalTz === undefined) delete process.env["TZ"];
  else process.env["TZ"] = originalTz;
});

const zones = [
  { tz: "UTC", januaryOffset: 0, julyOffset: 0 },
  { tz: "Asia/Seoul", januaryOffset: -540, julyOffset: -540 },
  { tz: "America/Los_Angeles", januaryOffset: 480, julyOffset: 420 },
];

describe.each(zones)("T01 game day with TZ=$tz", ({ tz, januaryOffset, julyOffset }) => {
  beforeEach(() => {
    process.env["TZ"] = tz;
  });

  it("actually runs in the requested process timezone", () => {
    expect(new Date("2026-01-15T00:00:00Z").getTimezoneOffset()).toBe(januaryOffset);
    expect(new Date("2026-07-15T00:00:00Z").getTimezoneOffset()).toBe(julyOffset);
  });

  it("assigns instants before 05:00 KST to the previous game day", () => {
    expect(gameDay("2025-06-26T00:00:00+09:00")).toBe("2025-06-25");
    expect(gameDay("2025-06-26T04:59:59+09:00")).toBe("2025-06-25");
    expect(gameDay("2025-06-26T05:00:00+09:00")).toBe("2025-06-26");
    expect(gameDay("2025-06-25T20:00:00.000Z")).toBe("2025-06-26");
    expect(gameDay(Date.UTC(2025, 5, 25, 19, 59, 59))).toBe("2025-06-25");
    expect(gameDay(new Date("2026-01-01T04:59:59+09:00"))).toBe("2025-12-31");
    // Los Angeles DST transition days must not move KST game days.
    expect(gameDay("2026-03-08T10:30:00Z")).toBe("2026-03-08");
    expect(gameDay("2026-11-01T09:30:00Z")).toBe("2026-11-01");
  });

  it("derives game-day bounds, collaboration ends and the admin range in KST", () => {
    expect(gameDayStart("2025-06-25")).toBe("2025-06-24T20:00:00.000Z");
    expect(gameDayEnd("2025-06-25")).toBe("2025-06-25T19:59:59.000Z");
    expect(Date.parse(collaborationEnd("2025-07-03T16:00:00+09:00"))).toBe(
      Date.parse("2025-07-31T04:59:59+09:00"),
    );
    expect(calendarRange("2026-10-18T19:17:44+09:00")).toEqual({
      start: "2026-10-18",
      end: "2026-11-18",
    });
    expect(calendarRange("2026-10-19T04:59:59+09:00").start).toBe("2026-10-18");
  });

  it("takes omitted years from the KST post time and keeps written KST wall clocks", () => {
    // 2026-01-01 03:00 KST is still 2025-12-31 in UTC and Los Angeles.
    expect(noticeDates("1/8(목) 12:00", "2026-01-01T03:00:00+09:00")[0]?.instant).toBe(
      "2026-01-08T12:00:00+09:00",
    );
    expect(noticeDates("- 6/25(목) 4:59까지", "2026-06-18T20:30:28+09:00", true)[0]?.instant).toBe(
      "2026-06-25T04:59:59+09:00",
    );
  });

  it("judges an end-only open notice identically", () => {
    const result = judgeSolo(
      {
        title: "솔로 레이드 오픈 안내",
        body: "✅ 진행 기간\n- 6/25(목) 4:59까지",
        postedAt: "2026-06-18T20:30:28+09:00",
      },
      [],
    );
    expect(result.action).toBe("confirmed");
    if (result.action !== "confirmed") return;
    expect(Date.parse(result.startAt)).toBe(Date.parse("2026-06-18T20:30:28+09:00"));
    expect(Date.parse(result.endAt)).toBe(Date.parse("2026-06-25T04:59:59+09:00"));
  });
});
