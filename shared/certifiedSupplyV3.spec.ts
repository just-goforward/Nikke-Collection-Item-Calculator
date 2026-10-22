import { describe, expect, it } from "vitest";
import { add, div, fromWire, mul, q, sub, toNumber, toWire, ZERO } from "./certifiedRational.ts";
import {
  assertCertifiedRuntimeSupplySnapshot,
  assertCertifiedSupplySnapshot,
  buildCertifiedSupplySnapshot,
  certifiedCohortWeights,
  certifiedRecurringRate,
  expectedCertifiedRefs,
} from "./certifiedSupply.ts";
import {
  CERTIFIED_SUPPLY_LAWS,
  getCertifiedLawDistribution,
  getCertifiedLawExpectedGain,
} from "./certifiedSupplyLaws.ts";
import { CERTIFIED_SUPPLY_HISTORY_DAYS } from "./certifiedSupplyModel.ts";
import { GAME_DAY_MS, gameDayKey, gameDayStartMs } from "./gameDay.ts";
import { projectSupplyReference } from "./supplyForecastProjection.ts";

const at = Date.parse("2026-10-01T05:00:00+09:00");
const snapshot = () =>
  buildCertifiedSupplySnapshot({
    version: "certified-daily-v3",
    asOf: new Date(at).toISOString(),
    revision: "v3-oracles",
    sourceHash: "a".repeat(64),
    soloPeriods: [],
    collaborationPeriods: [],
  });
const gain = (lawId: string, count = 1) => getCertifiedLawExpectedGain({ lawId, count }, 0);
const historic = () => {
  const value = snapshot();
  return {
    ...value,
    version: "certified-daily-v2" as const,
    rules: value.rules.map(({ weeklyFixed: _weeklyFixed, ...rule }) => rule),
    events: value.events.filter((event) => event.kind !== "weekly-kits"),
  };
};

describe("FRP-v3.1 exact supply rules", () => {
  it("keeps box, Tuesday, Wednesday and Solo expectations in exact fractions", () => {
    expect(gain("regular-box-v1")).toEqual([q(12, 5), q(1, 5), ZERO]);
    expect(gain("box-ii-v1")).toEqual([q(7, 2), q(2, 5), q(1, 5)]);
    expect(gain("box-ii-v1", 5)).toEqual([q(35, 2), q(2), q(1)]);
    expect(gain("box-ii-v1", 10)).toEqual([q(35), q(4), q(2)]);
    expect(gain("deterministic:10,10,0")).toEqual([q(10), q(10), ZERO]);
    for (const cohort of [0, 1, 2, 3] as const)
      expect(
        getCertifiedLawDistribution({ lawId: "deterministic:10,10,0", count: 1 }, cohort),
      ).toEqual([{ pieces: [10, 10, 0], mass: q(1) }]);
    const rule = snapshot().rules[0];
    if (!rule) throw new Error("fixture_rule");
    const solo = rule.soloDays.map((refs) =>
      expectedCertifiedRefs(refs, certifiedCohortWeights(undefined, "certified-daily-v3"), {}),
    );
    expect(solo).toEqual([
      [q(144, 5), q(12, 5), ZERO],
      [q(188, 5), q(4), q(8, 5)],
      ...Array.from({ length: 5 }, () => [q(42), q(24, 5), q(12, 5)]),
    ]);
  });

  it("uses the exact 1:2:3:1 mixture for a normal week and recurring rates", () => {
    const value = snapshot();
    const dispatch = getCertifiedLawExpectedGain;
    const cohorts = [0, 1, 2, 3].map((cohort) =>
      dispatch({ lawId: "dispatch-board-v1", count: 1 }, cohort as 0 | 1 | 2 | 3),
    );
    const daily = [0, 1, 2].map((color) =>
      div(
        cohorts.reduce(
          (total, row, cohort) => add(total, mul(row[color] ?? ZERO, q([1, 2, 3, 1][cohort] ?? 0))),
          ZERO,
        ),
        q(7),
      ),
    );
    expect(daily.map(toNumber)).toEqual([
      expect.closeTo(9.297939600874928, 14),
      expect.closeTo(2.312534957132167, 14),
      expect.closeTo(0.831504399273351, 14),
    ]);
    const projected = projectSupplyReference(value, {
      from: at,
      until: at + 7 * GAME_DAY_MS,
      scheduleStatus: "confirmed",
    });
    if (!projected.available) throw new Error(projected.reason);
    expect(projected.expected).toEqual(
      daily.map((d, color) => add(mul(d, q(7)), [q(55, 2), q(12), q(1)][color] ?? ZERO)),
    );
    const before = certifiedRecurringRate(historic());
    const after = certifiedRecurringRate(value);
    expect(after.map((rate, color) => sub(rate, before[color] ?? ZERO))).toEqual([
      q(10, 7),
      q(10, 7),
      ZERO,
    ]);
    expect(after.map(toNumber)).toEqual([
      expect.closeTo(22.23202481390751, 12),
      expect.closeTo(5.017296861894071, 12),
      expect.closeTo(1.417469311554053, 12),
    ]);
  });

  it("generates seven historical days, eight future Wednesdays, and no collaboration multiplier", () => {
    const value = snapshot();
    expect(Date.parse(value.coverage.from)).toBe(at - CERTIFIED_SUPPLY_HISTORY_DAYS * GAME_DAY_MS);
    expect(value.coverage.past.complete).toBe(false);
    expect(value.coverage.past.missing).toContain("history_coverage");
    expect(value.coverage.past.missing).not.toContain("authority_coverage");
    expect(
      value.events.every((event) => Date.parse(event.at) >= Date.parse(value.coverage.from)),
    ).toBe(true);
    const future = value.events.filter(
      (event) =>
        event.kind === "weekly-kits" &&
        Date.parse(event.at) >= at + GAME_DAY_MS &&
        Date.parse(event.at) < at + 57 * GAME_DAY_MS,
    );
    expect(future).toHaveLength(8);
    expect(
      expectedCertifiedRefs(
        future.flatMap((event) => event.refs),
        certifiedCohortWeights(undefined, "certified-daily-v3"),
        {},
      ),
    ).toEqual([q(80), q(80), ZERO]);
    const collaboration = buildCertifiedSupplySnapshot({
      version: "certified-daily-v3",
      asOf: value.asOf,
      revision: "collaboration",
      sourceHash: "a".repeat(64),
      soloPeriods: [],
      collaborationPeriods: [
        {
          effectiveFrom: value.asOf,
          effectiveUntil: new Date(at + 7 * GAME_DAY_MS).toISOString(),
        },
      ],
    });
    expect(collaboration.events.filter((event) => event.kind === "weekly-kits")).toEqual(
      value.events.filter((event) => event.kind === "weekly-kits"),
    );
    const window = { from: at, until: at + 7 * GAME_DAY_MS, scheduleStatus: "confirmed" as const };
    const normal = projectSupplyReference(value, window);
    const collab = projectSupplyReference(collaboration, window);
    if (!normal.available || !collab.available) throw new Error("fixture_window");
    expect(collab.expected.map((n, color) => sub(n, normal.expected[color] ?? ZERO))).toEqual([
      q(35, 2),
      q(2),
      q(1),
    ]);
  });

  it("uses Wednesday 05:00 KST and an exclusive next-Tuesday 05:00 deadline without DST", () => {
    expect(gameDayKey(Date.parse("2026-10-07T04:59:59+09:00"))).toBe("2026-10-06");
    expect(gameDayKey(Date.parse("2026-10-07T05:00:00+09:00"))).toBe("2026-10-07");
    for (const event of snapshot().events.filter((event) => event.kind === "weekly-kits")) {
      const epoch = Date.parse(event.at);
      expect(epoch).toBe(gameDayStartMs(epoch));
      expect(new Date(epoch + 9 * 3_600_000).getUTCDay()).toBe(3);
      expect(Date.parse(event.expiresAt ?? "") - epoch).toBe(6 * GAME_DAY_MS);
      expect(event.refs).toEqual([{ lawId: "deterministic:10,10,0", count: 1 }]);
    }
    expect(gameDayStartMs(Date.parse("2026-11-04T12:00:00+09:00"))).toBe(
      Date.parse("2026-11-03T20:00:00Z"),
    );
  });
});

describe("v3 runtime admission, separate from historical law readers", () => {
  it("accepts exactly the builtin law set and keeps v2 finite fixtures readable", () => {
    expect(assertCertifiedRuntimeSupplySnapshot(snapshot()).version).toBe("certified-daily-v3");
    const legacy = historic();
    legacy.laws = [
      ...legacy.laws,
      {
        id: "historical-finite",
        kind: "finite",
        modelVersion: "historical",
        outcomes: [{ pieces: [1, 2, 3], mass: toWire(q(1)) }],
      },
    ];
    expect(assertCertifiedSupplySnapshot(legacy)).toBe(legacy);
    expect(legacy.laws.at(-1)?.outcomes?.map((row) => fromWire(row.mass))).toEqual([q(1)]);
  });

  it("rejects novel or shadowing finite laws and every other deterministic tuple", () => {
    const value = snapshot();
    const finite = {
      kind: "finite" as const,
      modelVersion: "override",
      outcomes: [
        {
          pieces: [99, 0, 0] as const,
          mass: toWire(q(1)),
        },
      ],
    };
    for (const id of [
      "novel",
      "dispatch-board-v1",
      "regular-box-v1",
      "box-ii-v1",
      "deterministic:10,10,0",
    ]) {
      expect(() =>
        assertCertifiedRuntimeSupplySnapshot({
          ...value,
          laws: [...CERTIFIED_SUPPLY_LAWS.filter((law) => law.id !== id), { id, ...finite }],
        }),
      ).toThrow("certified_v3_builtin_laws_required");
    }
    expect(() =>
      assertCertifiedRuntimeSupplySnapshot({
        ...value,
        events: value.events.map((event, index) =>
          index === 0 ? { ...event, refs: [{ lawId: "deterministic:9,10,0", count: 1 }] } : event,
        ),
      }),
    ).toThrow("certified_v3_law_reference_invalid");
    expect(() =>
      assertCertifiedRuntimeSupplySnapshot({ ...value, laws: value.laws.slice(1) }),
    ).toThrow();
  });

  it("rejects missing Wednesday arrivals and a non-reset arrival", () => {
    const value = snapshot();
    expect(() =>
      assertCertifiedRuntimeSupplySnapshot({
        ...value,
        events: value.events.filter((event) => event.kind !== "weekly-kits"),
      }),
    ).toThrow("certified_v3_weekly_event_missing");
    expect(() =>
      assertCertifiedRuntimeSupplySnapshot({
        ...value,
        events: value.events.map((event) =>
          event.kind === "weekly-kits"
            ? { ...event, at: new Date(Date.parse(event.at) + 1000).toISOString() }
            : event,
        ),
      }),
    ).toThrow("certified_v3_weekly_event_invalid");
  });
});
