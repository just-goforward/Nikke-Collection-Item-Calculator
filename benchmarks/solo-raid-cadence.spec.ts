import { describe, expect, it } from "vitest";
import {
  deriveSoloRaidCadenceDays,
  SOLO_RAID_CADENCE_SUMMARY,
  SOLO_RAID_ROUND_HISTORY,
  soloRaidSourceUrl,
} from "../shared/soloRaidCadence";

describe("Solo Raid cadence census", () => {
  it("derives the cadence from all 40 reconciled new-round starts", () => {
    expect(SOLO_RAID_ROUND_HISTORY).toHaveLength(40);
    expect(SOLO_RAID_CADENCE_SUMMARY).toMatchObject({
      rounds: 40,
      intervals: 39,
      medianDays: 28,
      minimumDays: 21,
      maximumDays: 42,
    });
    expect(SOLO_RAID_CADENCE_SUMMARY.meanDays).toBeCloseTo(30.6923076923, 9);
    expect(SOLO_RAID_CADENCE_SUMMARY.frequency).toEqual({
      21: 2,
      22: 1,
      23: 1,
      26: 1,
      27: 1,
      28: 17,
      29: 1,
      34: 1,
      35: 9,
      36: 1,
      41: 1,
      42: 3,
    });
    expect(SOLO_RAID_ROUND_HISTORY.map((entry) => entry.round)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
    expect(soloRaidSourceUrl(SOLO_RAID_ROUND_HISTORY[0])).toBe(
      "https://game.naver.com/lounge/nikke/board/detail/1950871",
    );
    expect(deriveSoloRaidCadenceDays(["2026-09-17"])).toBe(28);
  });
});
