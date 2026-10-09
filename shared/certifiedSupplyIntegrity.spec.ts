import { describe, expect, it } from "vitest";
import * as Supply from "./certifiedSupply.ts";
import { getCertifiedLawExpectedGain } from "./certifiedSupplyLaws.ts";

const fixture = () =>
  Supply.buildCertifiedSupplySnapshot({
    asOf: "2026-08-20T09:30:00+09:00",
    revision: "review-6",
    sourceHash: "a".repeat(64),
    soloPeriods: [
      {
        round: 40,
        effectiveFrom: "2026-08-20T12:00:00+09:00",
        effectiveUntil: "2026-08-27T04:59:00+09:00",
        scheduleStatus: "confirmed",
      },
    ],
    collaborationPeriods: [],
  });

describe("review 6 shared supply integrity", () => {
  it("declares independent event laws conditional on the fixed personal cohort", () => {
    const snapshot = fixture();
    expect(snapshot).toHaveProperty("futureLawSemantics", "independent_given_cohort-v1");
    expect(() =>
      Supply.assertCertifiedSupplySnapshot({
        ...snapshot,
        futureLawSemantics: "joint_scenarios-v1",
      }),
    ).toThrow("future_law_semantics");
  });

  it("rejects unsupported joint scenario metadata rather than proving a Cartesian witness", () => {
    const snapshot = fixture();
    expect(() => Supply.assertCertifiedSupplySnapshot({ ...snapshot, jointScenarios: [] })).toThrow(
      "unknown_field",
    );
    expect(() =>
      Supply.assertCertifiedSupplySnapshot({
        ...snapshot,
        events: [{ ...snapshot.events[0], scenarioId: "dependent" }, ...snapshot.events.slice(1)],
      }),
    ).toThrow("unknown_field");
    expect(() =>
      Supply.assertCertifiedSupplySnapshot({
        ...snapshot,
        laws: [{ ...snapshot.laws[0], dependence: "joint" }, ...snapshot.laws.slice(1)],
      }),
    ).toThrow("unknown_field");
  });

  it("rejects unknown nested authority and rational metadata", () => {
    const snapshot = fixture();
    const custom = {
      id: "finite",
      kind: "finite",
      modelVersion: "fixture",
      outcomes: [
        { pieces: [1, 0, 0], mass: { numerator: "1", denominator: "1", scenario: "dependent" } },
      ],
    };
    for (const candidate of [
      { ...snapshot, coverage: { ...snapshot.coverage, extra: true } },
      { ...snapshot, cadence: { ...snapshot.cadence, extra: true } },
      { ...snapshot, delayState: { ...snapshot.delayState, extra: true } },
      { ...snapshot, rules: [{ ...snapshot.rules[0], extra: true }] },
      { ...snapshot, laws: [...snapshot.laws, custom] },
    ])
      expect(() => Supply.assertCertifiedSupplySnapshot(candidate)).toThrow("unknown_field");
  });

  it("rejects hidden array metadata and sparse raw-piece tuples", () => {
    const snapshot = fixture();
    const events = Object.assign([...snapshot.events], { scenarioId: "joint" });
    expect(() => Supply.assertCertifiedSupplySnapshot({ ...snapshot, events })).toThrow(
      "unknown_field",
    );
    const law = {
      id: "sparse",
      kind: "finite",
      modelVersion: "fixture",
      outcomes: [{ pieces: Array(3), mass: { numerator: "1", denominator: "1" } }],
    };
    expect(() =>
      Supply.assertCertifiedSupplySnapshot({ ...snapshot, laws: [...snapshot.laws, law] }),
    ).toThrow();
  });

  it("checks the caller budget before walking authority collections", () => {
    expect(() =>
      Supply.assertCertifiedSupplySnapshot(fixture(), () => {
        throw new Error("caller_budget");
      }),
    ).toThrow("caller_budget");
  });

  it("preserves noon day-zero arrivals and claims prior-date rewards only while unexpired", () => {
    const snapshot = fixture();
    const event = snapshot.events.find((row) => row.id === "solo:r40:day1");
    if (!event) throw new Error("certified_solo_fixture_event_missing");
    expect(event.gameDate).toBe("2026-08-20");
    expect(event.at).toBe("2026-08-20T03:00:00.000Z");
    expect(Supply.isCertifiedEventClaimable(snapshot, event)).toBe(false);
    expect(Supply.isCertifiedEventClaimable(snapshot, event, "2026-08-20T12:30:00+09:00")).toBe(
      true,
    );
    expect(Supply.isCertifiedEventClaimable(snapshot, event, "2026-08-21T05:30:00+09:00")).toBe(
      true,
    );
    expect(
      Supply.isCertifiedEventClaimable(
        snapshot,
        { ...event, expiresAt: null },
        "2026-08-21T05:30:00+09:00",
      ),
    ).toBe(false);
    expect(Supply.isCertifiedEventClaimable(snapshot, event, "2026-08-27T04:59:00+09:00")).toBe(
      false,
    );
    expect(
      Supply.isCertifiedEventClaimable(
        snapshot,
        { ...event, cancelled: true },
        "2026-08-20T12:30:00+09:00",
      ),
    ).toBe(false);
  });

  it("prices a cold dispatch law without enumerating weighted boards", () => {
    let checks = 0;
    const gain = getCertifiedLawExpectedGain({ lawId: "dispatch-board-v1", count: 1 }, 2, {
      checkBudget: () => {
        checks += 1;
      },
    });
    expect(gain).toHaveLength(3);
    expect(checks).toBeLessThanOrEqual(10);
  });

  it("keeps the audited cadence when an explicit later round has an unknown intervening round", () => {
    const snapshot = Supply.buildCertifiedSupplySnapshot({
      asOf: "2026-10-22T09:30:00+09:00",
      revision: "gap",
      sourceHash: "b".repeat(64),
      soloPeriods: [
        {
          round: 42,
          effectiveFrom: "2026-10-22T12:00:00+09:00",
          effectiveUntil: "2026-10-29T04:59:00+09:00",
          scheduleStatus: "confirmed",
        },
      ],
      collaborationPeriods: [],
    });
    expect(snapshot.cadence).toMatchObject({ numerator: 1197, denominator: 39, rounds: 40 });
    expect(snapshot.delayState.anchorRound).toBe(42);
    expect(snapshot.soloRounds.some((round) => round.round === 41)).toBe(false);
    expect(snapshot.events.some((event) => event.round === 41)).toBe(false);
    expect(snapshot.warnings).toContain("confirmed_solo_history_gap:r41");
  });
});
