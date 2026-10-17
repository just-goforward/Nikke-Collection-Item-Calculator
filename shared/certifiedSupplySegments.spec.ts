import { describe, expect, it } from "vitest";
import { buildCertifiedSupplySnapshot, isCertifiedEventClaimable } from "./certifiedSupply";
import { assertSupplyCoherence } from "./certifiedSupplyCoherence";
import type { CertifiedSupplyBuildInput } from "./certifiedSupplyModel";
import { supplyReferenceWindow } from "./supplyForecastProjection";

const input: CertifiedSupplyBuildInput = {
  asOf: "2026-06-20T12:00:00+09:00",
  revision: "season-38-segments",
  sourceHash: "a".repeat(64),
  soloPeriods: [],
  collaborationPeriods: [],
  soloRounds: [
    {
      round: 38,
      segments: [
        {
          segment: 1,
          kind: "initial",
          effectiveFrom: "2026-06-18T12:00:00+09:00",
          effectiveUntil: "2026-06-23T04:59:59+09:00",
          rewardFromGameDate: "2026-06-18",
          rewardUntilGameDate: "2026-06-23",
          sourceIds: ["initial"],
        },
        {
          segment: 2,
          kind: "reopen",
          effectiveFrom: "2026-07-03T12:00:00+09:00",
          effectiveUntil: "2026-07-08T04:59:00+09:00",
          rewardFromGameDate: "2026-07-03",
          rewardUntilGameDate: "2026-07-08",
          sourceIds: ["reopen"],
        },
      ],
    },
  ],
};

describe("season 38 suspended and reopened round", () => {
  it("skips out-of-coverage rewards before looking up their rules", () => {
    const snapshot = buildCertifiedSupplySnapshot({
      ...input,
      asOf: "2026-08-28T12:00:00+09:00",
      soloRounds: [
        {
          round: 40,
          segments: [
            {
              segment: 1,
              kind: "initial",
              effectiveFrom: "2026-08-20T12:00:00+09:00",
              effectiveUntil: "2026-08-25T04:59:59+09:00",
              rewardFromGameDate: "2026-08-20",
              rewardUntilGameDate: "2026-08-25",
              sourceIds: ["coverage-regression"],
            },
          ],
        },
      ],
    });
    expect(
      snapshot.events.some((event) => event.round === 40 && event.gameDate === "2026-08-20"),
    ).toBe(false);
    expect(
      snapshot.events.filter((event) => event.round === 40).map((event) => event.dayNumber),
    ).toEqual([2, 3, 4, 5]);
  });
  it("issues ten rewards with two independent five-day claim windows", () => {
    const snapshot = buildCertifiedSupplySnapshot(input);
    const events = snapshot.events.filter((event) => event.round === 38);
    expect(snapshot.version).toBe("certified-daily-v4");
    expect(events.map((event) => event.id)).toEqual([
      ...Array.from({ length: 5 }, (_, day) => `solo:r38:day${day + 1}`),
      ...Array.from({ length: 5 }, (_, day) => `solo:r38:segment2:day${day + 1}`),
    ]);
    expect(events.some((event) => ["2026-06-23", "2026-07-08"].includes(event.gameDate))).toBe(
      false,
    );
    for (const event of events.slice(0, 5))
      expect(isCertifiedEventClaimable(snapshot, event, "2026-07-03T13:00:00+09:00")).toBe(false);
    expect(supplyReferenceWindow(snapshot, Date.parse("2026-06-28T12:00:00+09:00"))).toBeNull();
    const activeRound = snapshot.soloRounds.find(
      (round) =>
        round.startGameDate <= "2026-06-28" &&
        round.endGameDate !== null &&
        round.endGameDate > "2026-06-28",
    );
    expect(activeRound?.round).toBe(38);
  });

  it.each(["old-id", "overlap", "day-six", "closure"] as const)("rejects %s", (attack) => {
    const snapshot = structuredClone(buildCertifiedSupplySnapshot(input));
    const event = snapshot.events.find((entry) => entry.id === "solo:r38:segment2:day1");
    const round = snapshot.soloRounds.find((entry) => entry.round === 38);
    if (!event || !round?.segments?.[1]) throw new Error("oracle_fixture_missing");
    if (attack === "old-id") event.id = "solo:r38:day1";
    if (attack === "overlap") round.segments[1].effectiveFrom = "2026-06-22T12:00:00+09:00";
    if (attack === "day-six") {
      event.dayNumber = 6;
      event.id = "solo:r38:segment2:day6";
    }
    if (attack === "closure") event.gameDate = "2026-07-08";
    expect(() => assertSupplyCoherence(snapshot)).toThrow();
  });
});
