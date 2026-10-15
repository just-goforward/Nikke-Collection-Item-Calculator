import { describe, expect, it } from "vitest";
import {
  assertCertifiedSupplySnapshot,
  buildCertifiedSupplySnapshot,
  compareCertifiedSupplyPeriods,
  viewCertifiedSupplySnapshot,
} from "./certifiedSupply";
import { GAME_DAY_MS } from "./gameDay";

const asOf = "2026-10-01T05:00:00+09:00";
const now = Date.parse(asOf);
const historyFrom = new Date(now - 7 * GAME_DAY_MS).toISOString();
const input = {
  asOf,
  revision: "complete-history",
  sourceHash: "a".repeat(64),
  soloPeriods: [],
  collaborationPeriods: [],
  historyCoverage: {
    from: historyFrom,
    until: new Date(now).toISOString(),
    raidDurations: true,
    collaborationPeriods: true,
    rewardRules: true,
  },
};

describe("seven-day certified supply history", () => {
  it.each([0, 8, 55, 57])("rejects unsupported history window size %s", (days) => {
    const snapshot = buildCertifiedSupplySnapshot(input);
    expect(() =>
      assertCertifiedSupplySnapshot({
        ...snapshot,
        coverage: {
          ...snapshot.coverage,
          past: {
            ...snapshot.coverage.past,
            from: new Date(now - days * GAME_DAY_MS).toISOString(),
            days,
            complete: false,
            missing: ["authority_coverage"],
          },
        },
      }),
    ).toThrow("certified_snapshot_query_window_invalid");
  });

  it("reports fully sourced history as complete and compares daily rates across unequal periods", () => {
    const built = buildCertifiedSupplySnapshot(input);
    const snapshot = assertCertifiedSupplySnapshot({
      ...built,
      soloRounds: [],
      events: built.events.filter((event) => event.kind !== "solo"),
    });
    expect(snapshot.coverage.past).toMatchObject({
      from: historyFrom,
      days: 7,
      complete: true,
      missing: [],
    });
    const viewed = viewCertifiedSupplySnapshot(snapshot, snapshot.asOf);
    expect(viewed.coverage.past).toEqual(snapshot.coverage.past);
    const comparison = compareCertifiedSupplyPeriods(viewed);
    expect(comparison.past.days).toBe(7);
    expect(comparison.future.days).toBe(56);
    expect(comparison.past.dailyAverage).toEqual(comparison.future.dailyAverage);
    expect(comparison.percentChange).toEqual(
      Array.from({ length: 3 }, () => ({ numerator: "0", denominator: "1" })),
    );
    expect(comparison.partial).toBe(false);
  });

  it("preserves missing evidence and out-of-authority history as incomplete", () => {
    const missing = buildCertifiedSupplySnapshot({
      ...input,
      historyCoverage: { ...input.historyCoverage, raidDurations: false },
    });
    expect(compareCertifiedSupplyPeriods(missing).past).toMatchObject({
      complete: false,
      missing: ["raid_durations"],
    });
    const earlier = viewCertifiedSupplySnapshot(
      buildCertifiedSupplySnapshot(input),
      new Date(now - GAME_DAY_MS).toISOString(),
    );
    expect(earlier.coverage.past.complete).toBe(false);
    expect(earlier.coverage.past.missing).toContain("authority_coverage");
    expect(compareCertifiedSupplyPeriods(earlier).percentChange).toEqual([null, null, null]);
  });

  it("normalizes an archived 56-day query window without extending its ledger", () => {
    const snapshot = buildCertifiedSupplySnapshot(input);
    const archived = assertCertifiedSupplySnapshot({
      ...snapshot,
      coverage: {
        ...snapshot.coverage,
        past: {
          ...snapshot.coverage.past,
          from: new Date(now - 56 * GAME_DAY_MS).toISOString(),
          days: 56,
          complete: false,
          missing: ["authority_coverage"],
        },
      },
    });
    const viewed = viewCertifiedSupplySnapshot(archived, archived.asOf);
    expect(viewed.coverage.past).toEqual(snapshot.coverage.past);
    expect(viewed.events).toBe(archived.events);
    expect(viewed.coverage.from).toBe(archived.coverage.from);
    expect(compareCertifiedSupplyPeriods(archived).past.complete).toBe(true);
  });
});
