import { describe, expect, it } from "vitest";

import { formatStagingForecastKstWindow } from "./supplyForecastPresentation";

const PROFILE = {
  effectiveFrom: "2026-08-30T20:00:00.000Z",
  effectiveUntil: "2026-08-31T20:00:00.000Z",
} as const;

describe("staging supply forecast presentation", () => {
  it("shows the exclusive 05:00 game-day boundary as an inclusive 04:59 KST window", () => {
    expect(formatStagingForecastKstWindow(PROFILE, "ko")).toEqual({
      from: "2026년 8월 31일 05:00",
      until: "2026년 9월 1일 04:59",
    });
    expect(formatStagingForecastKstWindow(PROFILE, "en")).toEqual({
      from: "Aug 31, 2026, 05:00",
      until: "Sep 1, 2026, 04:59",
    });
    expect(formatStagingForecastKstWindow(PROFILE, "ja")).toEqual({
      from: "2026年8月31日 05:00",
      until: "2026年9月1日 04:59",
    });
  });

  it("supports an open-ended final profile", () => {
    expect(formatStagingForecastKstWindow({ ...PROFILE, effectiveUntil: null }, "ko")).toEqual({
      from: "2026년 8월 31일 05:00",
      until: null,
    });
  });
});
