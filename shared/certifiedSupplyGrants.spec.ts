import { describe, expect, it } from "vitest";
import {
  buildCertifiedSupplySnapshot,
  certifiedCohortWeights,
  certifiedRecurringRate,
  expectedCertifiedRefs,
  isCertifiedEventClaimable,
} from "./certifiedSupply";

describe("one-time kit grants", () => {
  it("issues II×56 plus regular×16 once without changing recurring prices", () => {
    const input = {
      asOf: "2026-06-23T05:00:00+09:00",
      revision: "grant-oracle",
      sourceHash: "a".repeat(64),
      soloPeriods: [],
      collaborationPeriods: [],
    };
    const base = buildCertifiedSupplySnapshot(input);
    const snapshot = buildCertifiedSupplySnapshot({
      ...input,
      grants: [
        {
          id: "grant:naver-board-11:123:2026-06-23:1",
          grantGameDate: "2026-06-23",
          refs: [
            { lawId: "box-ii-v1", count: 56 },
            { lawId: "regular-box-v1", count: 16 },
          ],
          claimWindowAssumed: true,
          sourceIds: ["notice:123"],
          restatementOf: [],
        },
      ],
    });
    const events = snapshot.events.filter((event) => event.kind === "grant");
    expect(events).toHaveLength(1);
    const event = events[0];
    if (!event) throw new Error("grant_missing");
    expect(event.at).toBe("2026-06-22T20:00:00.000Z");
    expect(event.refs.map((ref) => ref.count)).toEqual([56, 16]);
    expect(event.expiresAt).toBeUndefined();
    expect(isCertifiedEventClaimable(snapshot, event, input.asOf)).toBe(true);
    expect(isCertifiedEventClaimable(snapshot, event, "2026-06-24T05:00:00+09:00")).toBe(false);
    expect(certifiedRecurringRate(snapshot)).toEqual(certifiedRecurringRate(base));
  });

  it("preserves exact same-law 2×32 and 1×64 expected gains", () => {
    const weights = certifiedCohortWeights();
    for (const lawId of ["box-ii-v1", "regular-box-v1"]) {
      expect(
        expectedCertifiedRefs(
          [
            { lawId, count: 32 },
            { lawId, count: 32 },
          ],
          weights,
          {},
        ),
      ).toEqual(expectedCertifiedRefs([{ lawId, count: 64 }], weights, {}));
    }
  });
});
