import { describe, expect, it } from "vitest";
import {
  kstDateKeyFromUnixSeconds,
  kstGameDateKeyFromUnixSeconds,
  STATISTICS_DATE_CONTRACT,
} from "./date-key";

function unixSeconds(iso: string) {
  return Date.parse(iso) / 1000;
}

describe("statistics date keys", () => {
  it("keeps the historical KST calendar-date contract unchanged", () => {
    expect(kstDateKeyFromUnixSeconds(unixSeconds("2026-08-26T04:59:59+09:00"))).toBe("2026-08-26");
  });

  it("changes the game date exactly at 05:00 KST", () => {
    expect(kstGameDateKeyFromUnixSeconds(unixSeconds("2026-08-26T04:59:59+09:00"))).toBe(
      "2026-08-25",
    );
    expect(kstGameDateKeyFromUnixSeconds(unixSeconds("2026-08-26T05:00:00+09:00"))).toBe(
      "2026-08-26",
    );
  });

  it("makes frozen and current write contracts explicit", () => {
    expect(STATISTICS_DATE_CONTRACT).toEqual({
      legacy: {
        id: "kst_calendar_date_v1",
        boundary: "00:00:00+09:00",
        acceptsNewWrites: false,
      },
      current: {
        id: "kst_game_day_0500_v2",
        boundary: "05:00:00+09:00",
        acceptsNewWrites: true,
      },
    });
  });
});
