import { describe, expect, it } from "vitest";
import {
  addGameDays,
  calendarRange,
  collaborationEnd,
  gameDay,
  gameDayEnd,
  gameDayStart,
  noticeEndSeconds,
} from "./game-day";

describe("v2 game-day boundaries (T01)", () => {
  it("assigns midnight and the last second before reset to the preceding day", () => {
    expect(gameDay("2026-06-26T00:00:00+09:00")).toBe("2026-06-25");
    expect(gameDay("2026-06-26T04:59:59+09:00")).toBe("2026-06-25");
    expect(gameDay("2026-06-26T05:00:00+09:00")).toBe("2026-06-26");
    expect(gameDay("2026-06-25T20:00:00Z")).toBe("2026-06-26");
  });
  it("preserves the inclusive 04:59:59 notice end", () => {
    expect(noticeEndSeconds(4, 59)).toBe(59);
    expect(noticeEndSeconds(17, 0)).toBe(0);
    expect(gameDayStart("2026-06-25")).toBe("2026-06-24T20:00:00.000Z");
    expect(gameDayEnd("2026-06-25")).toBe("2026-06-25T19:59:59.000Z");
  });
  it("clamps next-month range including leap years and year rollover", () => {
    expect(calendarRange("2026-01-31T12:00:00+09:00")).toEqual({
      start: "2026-01-31",
      end: "2026-02-28",
    });
    expect(calendarRange("2024-01-31T12:00:00+09:00").end).toBe("2024-02-29");
    expect(calendarRange("2026-12-31T12:00:00+09:00").end).toBe("2027-01-31");
  });
  it("ends collaborations after exactly 28 included game days", () => {
    expect(collaborationEnd("2026-07-03T12:00:00+09:00")).toBe("2026-07-30T19:59:59.000Z");
    expect(addGameDays("2024-02-28", 1)).toBe("2024-02-29");
  });
  it("rejects invalid dates and nonintegral day offsets", () => {
    expect(() => gameDay("invalid")).toThrow(RangeError);
    expect(() => gameDayStart("2026-02-29")).toThrow(RangeError);
    expect(() => addGameDays("2026-01-01", 0.5)).toThrow(RangeError);
    expect(() => noticeEndSeconds(24, 0)).toThrow(RangeError);
  });
});
