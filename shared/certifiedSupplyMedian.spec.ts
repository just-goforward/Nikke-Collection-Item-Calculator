import { expect, it } from "vitest";
import {
  assertCertifiedSupplySnapshot,
  buildCertifiedSupplySnapshot,
  viewCertifiedSupplySnapshot,
} from "./certifiedSupply";
import type { CertifiedSupplyBuildInput } from "./certifiedSupplyModel";

const input: CertifiedSupplyBuildInput = {
  cadenceVersion: "observed-median-v2",
  asOf: "2026-10-18T12:00:00+09:00",
  revision: "median-test",
  sourceHash: "a".repeat(64),
  collaborationPeriods: [],
  soloPeriods: [
    {
      round: 41,
      effectiveFrom: "2026-09-24T12:00:00+09:00",
      effectiveUntil: "2026-10-01T04:59:59+09:00",
      scheduleStatus: "confirmed",
    },
    {
      round: 42,
      effectiveFrom: "2026-10-15T12:00:00+09:00",
      effectiveUntil: "2026-10-22T04:59:59+09:00",
      scheduleStatus: "confirmed",
    },
  ],
};

it("builds the calendar S43 prediction as validated certified supply", () => {
  const snapshot = buildCertifiedSupplySnapshot(input);
  expect(() => assertCertifiedSupplySnapshot(snapshot)).not.toThrow();
  expect(snapshot.cadence).toMatchObject({ version: "observed-median-v2", medianDays: 28 });
  expect(snapshot.soloRounds.find((round) => round.round === 43)?.segments?.[0]).toMatchObject({
    effectiveFrom: "2026-11-12T03:00:00.000Z",
    effectiveUntil: "2026-11-18T19:59:59.000Z",
  });
});

it("replaces a legacy weekly offset with a daily waiting shift", () => {
  const snapshot = buildCertifiedSupplySnapshot({
    ...input,
    asOf: "2026-11-13T05:00:00+09:00",
    delayState: { anchorRound: 42, anchorGameDate: "2026-10-15", offsetDays: 7 },
  });
  expect(snapshot.delayState.offsetDays).toBe(2);
  expect(snapshot.soloRounds.find((round) => round.round === 43)?.sourceIds).toContain("공지 대기");
  expect(() => assertCertifiedSupplySnapshot(snapshot)).not.toThrow();
});

it("keeps browser aging aligned with a fresh median prediction", () => {
  const asOf = "2026-11-13T05:00:00+09:00";
  const adopted = buildCertifiedSupplySnapshot(input);
  const before = JSON.stringify(adopted);
  const viewed = viewCertifiedSupplySnapshot(adopted, asOf);
  expect(JSON.stringify(adopted)).toBe(before);
  expect(viewCertifiedSupplySnapshot(viewed, asOf)).toEqual(viewed);
  const fresh = buildCertifiedSupplySnapshot({ ...input, asOf });
  expect(viewed.soloRounds.find((round) => round.round === 43)).toEqual(
    fresh.soloRounds.find((round) => round.round === 43),
  );
});

it("uses the confirmed interrupted initial segment duration", () => {
  const snapshot = buildCertifiedSupplySnapshot({
    ...input,
    soloPeriods: input.soloPeriods.slice(0, 1),
    soloRounds: [
      {
        round: 42,
        segments: [
          {
            segment: 1,
            kind: "initial",
            effectiveFrom: "2026-10-15T12:00:00+09:00",
            effectiveUntil: "2026-10-15T17:00:00+09:00",
            rewardFromGameDate: "2026-10-15",
            rewardUntilGameDate: "2026-10-16",
            sourceIds: ["confirmed-interruption"],
          },
        ],
      },
    ],
  });
  expect(
    snapshot.soloRounds.find((round) => round.round === 43)?.segments?.[0]?.effectiveUntil,
  ).toBe("2026-11-12T08:00:00.000Z");
});
