import { describe, expect, it } from "vitest";
import {
  DISPATCH_COHORT_EXPECTED_GAIN,
  DISPATCH_DAILY_EXPECTED_GAIN,
  enumerateDispatchExpectedGain,
} from "../../shared/supplyForecastModel";
import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import type { NormalizedSourceItem, ScheduleEvent } from "./types";

const sourceItem: NormalizedSourceItem = {
  source: "naver-board-56",
  itemId: "8060044",
  url: "https://game.naver.com/lounge/nikke/board/detail/8060044",
  title: "8월 솔로 레이드",
  excerpt: "솔로 레이드 8월 20일 12:00 ~ 8월 27일 4:59",
  normalizedText: "솔로 레이드 8월 20일 12:00 ~ 8월 27일 4:59",
  publishedAt: "2026-08-18T03:00:00.000Z",
  contentHash: "a".repeat(64),
  structured: true,
  official: true,
};

const soloEvent: ScheduleEvent = {
  eventId: "naver-board-56:8060044:solo",
  eventType: "solo",
  sourceItem,
  startsAt: "2026-08-20T03:00:00.000Z",
  endsAt: "2026-08-26T19:59:00.000Z",
  scheduleStatus: "confirmed",
  manualReview: false,
  reason: null,
};

describe("forecast candidate model", () => {
  it("independently enumerates the 0/1/2 reroll dispatch cohorts", () => {
    expect(enumerateDispatchExpectedGain(0)).toEqual(DISPATCH_COHORT_EXPECTED_GAIN.noReroll);
    expect(enumerateDispatchExpectedGain(1)).toEqual(DISPATCH_COHORT_EXPECTED_GAIN.oneReroll);
    expect(enumerateDispatchExpectedGain(2)).toEqual(DISPATCH_COHORT_EXPECTED_GAIN.twoRerolls);
    expect(DISPATCH_DAILY_EXPECTED_GAIN.blue).toBeCloseTo(8.947399682, 9);
    expect(DISPATCH_DAILY_EXPECTED_GAIN.purple).toBeCloseTo(2.014546824, 9);
    expect(DISPATCH_DAILY_EXPECTED_GAIN.yellow).toBeCloseTo(0.71420816, 9);
  });

  it("builds a monotone, open-ended daily profile during Solo Raid", async () => {
    const resolved = resolveSoloSchedule([soloEvent], Date.parse("2026-08-24T00:00:00Z"));
    if (!resolved) throw new Error("Expected a resolved schedule.");
    const result = await buildForecastCandidate(
      resolved,
      [],
      { status: "x_unavailable", sourceItem: null, reason: "test" },
      Date.parse("2026-08-24T00:00:00Z"),
      1,
    );

    expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.candidate.forecastId).toBe("supply-2026-08-24-v1");
    expect(result.candidate.profiles.at(-1)?.effectiveUntil).toBeNull();
    expect(result.candidate.warnings).toContain(
      "X could not be cross-checked automatically; manual confirmation is required.",
    );
    for (let index = 1; index < result.candidate.profiles.length; index += 1) {
      const previous = result.candidate.profiles[index - 1]?.expectedGain;
      const current = result.candidate.profiles[index]?.expectedGain;
      if (!previous || !current) throw new Error("Profile sequence is incomplete.");
      expect(current.blue).toBeLessThanOrEqual(previous.blue);
      expect(current.purple).toBeLessThanOrEqual(previous.purple);
      expect(current.yellow).toBeLessThanOrEqual(previous.yellow);
    }
  });

  it("estimates the next new round from the median of recent valid intervals", () => {
    const starts = [
      "2026-03-19",
      "2026-04-16",
      "2026-05-14",
      "2026-06-11",
      "2026-07-09",
      "2026-08-06",
    ];
    const events = starts.map((date, index): ScheduleEvent => {
      const start = Date.parse(`${date}T12:00:00+09:00`);
      return {
        ...soloEvent,
        eventId: `solo-${index}`,
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 7 * 86_400_000 - 7 * 60 * 60 * 1000 - 60 * 1000).toISOString(),
      };
    });

    const resolved = resolveSoloSchedule(events, Date.parse("2026-08-20T00:00:00Z"));

    expect(resolved?.scheduleStatus).toBe("estimated");
    expect(resolved?.cadenceDays).toBe(28);
    expect(resolved?.event.startsAt).toBe("2026-09-03T03:00:00.000Z");
    expect(resolved?.evidenceEvents).toHaveLength(6);
  });

  it("blocks a confirmed new-round cadence outside the validated 21-35 day range", () => {
    const previous: ScheduleEvent = {
      ...soloEvent,
      eventId: "solo-previous",
      startsAt: "2026-07-31T03:00:00.000Z",
      endsAt: "2026-08-06T19:59:00.000Z",
    };

    expect(() =>
      resolveSoloSchedule([previous, soloEvent], Date.parse("2026-08-19T00:00:00Z")),
    ).toThrow("confirmed_solo_cadence_out_of_range");
  });
});
