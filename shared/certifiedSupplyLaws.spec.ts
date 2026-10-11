import { describe, expect, it } from "vitest";
import { add, mul, type Q, q, sum, toNumber, toWire, ZERO } from "./certifiedRational.ts";
import { buildCertifiedSupplySnapshot } from "./certifiedSupply.ts";
import {
  CERTIFIED_SUPPLY_LAWS,
  type CertifiedLawOptions,
  type CertifiedSupplyLaw,
  dispatchLaw,
  getCertifiedLawDistribution,
  getCertifiedLawExpectedGain,
} from "./certifiedSupplyLaws.ts";
import { DISPATCH_COHORT_EXPECTED_GAIN } from "./supplyForecastModel.ts";

const finiteIds = [
  "regular-box-v1",
  "box-ii-v1",
  "dispatch-board-v1",
  "deterministic:1,2,3",
  "deterministic:custom",
  "custom",
];

describe("explicit finite supply-law authority", () => {
  it.each(finiteIds)("honors validated finite %s over synthesized laws", (id) => {
    const finite: CertifiedSupplyLaw = {
      id,
      kind: "finite",
      modelVersion: "fixture-v1",
      outcomes: [{ pieces: [99, 0, 0], mass: { numerator: "2", denominator: "2" } }],
    };
    const laws = [finite, ...CERTIFIED_SUPPLY_LAWS.filter((law) => law.id !== id)];
    const snapshot = buildCertifiedSupplySnapshot({
      asOf: "2026-09-30T08:00:00.000Z",
      revision: "finite-override",
      sourceHash: "a".repeat(64),
      soloPeriods: [],
      collaborationPeriods: [],
      laws,
    });
    expect(snapshot.laws).toEqual(laws);
    for (const cohort of [0, 1, 2] as const) {
      expect(getCertifiedLawDistribution({ lawId: id, count: 1 }, cohort, { laws })).toEqual([
        { pieces: [99, 0, 0], mass: q(1) },
      ]);
      expect(getCertifiedLawExpectedGain({ lawId: id, count: 1 }, cohort, { laws })).toEqual([
        q(99),
        q(0),
        q(0),
      ]);
      expect(getCertifiedLawDistribution({ lawId: id, count: 0 }, cohort, { laws })).toEqual([
        { pieces: [0, 0, 0], mass: q(1) },
      ]);
      expect(getCertifiedLawExpectedGain({ lawId: id, count: 0 }, cohort, { laws })).toEqual([
        q(0),
        q(0),
        q(0),
      ]);
    }
  });

  it.each(finiteIds)("preserves finite cohort precedence and ordered support for %s", (id) => {
    const laws: readonly CertifiedSupplyLaw[] = [
      {
        id,
        kind: "finite",
        modelVersion: "fixture-v1",
        outcomes: [{ pieces: [99, 0, 0], mass: toWire(q(1)) }],
        outcomesByCohort: [
          [
            { pieces: [9, 0, 0], mass: toWire(q(0)) },
            { pieces: [2, 0, 0], mass: toWire(q(1, 2)) },
            { pieces: [0, 0, 0], mass: toWire(q(1, 2)) },
          ],
          [{ pieces: [0, 3, 0], mass: toWire(q(1)) }],
          [{ pieces: [0, 0, 6], mass: toWire(q(1)) }],
        ],
      },
    ];
    expect(getCertifiedLawDistribution({ lawId: id, count: 1 }, 0, { laws })).toEqual([
      { pieces: [2, 0, 0], mass: q(1, 2) },
      { pieces: [0, 0, 0], mass: q(1, 2) },
    ]);
    if (id !== "dispatch-board-v1") {
      expect(getCertifiedLawDistribution({ lawId: id, count: 2 }, 0, { laws })).toEqual([
        { pieces: [4, 0, 0], mass: q(1, 4) },
        { pieces: [2, 0, 0], mass: q(1, 2) },
        { pieces: [0, 0, 0], mass: q(1, 4) },
      ]);
    }
    expect(getCertifiedLawDistribution({ lawId: id, count: 1 }, 1, { laws })).toEqual([
      { pieces: [0, 3, 0], mass: q(1) },
    ]);
    expect(getCertifiedLawDistribution({ lawId: id, count: 1 }, 2, { laws })).toEqual([
      { pieces: [0, 0, 6], mass: q(1) },
    ]);
    expect(getCertifiedLawExpectedGain({ lawId: id, count: 1 }, 0, { laws })).toEqual([
      q(1),
      q(0),
      q(0),
    ]);
  });
});

describe("canonical supply laws and finite boundaries", () => {
  it("keeps canonical constants and synthesized deterministic laws isolated from finite overrides", () => {
    const configurations: readonly CertifiedLawOptions[] = [{}, { laws: CERTIFIED_SUPPLY_LAWS }];
    for (const options of configurations) {
      expect(
        getCertifiedLawDistribution({ lawId: "regular-box-v1", count: 1 }, 0, options),
      ).toEqual([
        { pieces: [3, 0, 0], mass: q(4, 5) },
        { pieces: [0, 1, 0], mass: q(1, 5) },
      ]);
      expect(
        getCertifiedLawExpectedGain({ lawId: "regular-box-v1", count: 1 }, 0, options),
      ).toEqual([q(12, 5), q(1, 5), q(0)]);
      expect(getCertifiedLawDistribution({ lawId: "box-ii-v1", count: 1 }, 0, options)).toEqual([
        { pieces: [5, 0, 0], mass: q(7, 10) },
        { pieces: [0, 2, 0], mass: q(1, 5) },
        { pieces: [0, 0, 2], mass: q(1, 10) },
      ]);
      expect(getCertifiedLawExpectedGain({ lawId: "box-ii-v1", count: 1 }, 0, options)).toEqual([
        q(7, 2),
        q(2, 5),
        q(1, 5),
      ]);
      expect(
        getCertifiedLawDistribution({ lawId: "deterministic:1,2,3", count: 1 }, 0, options),
      ).toEqual([{ pieces: [1, 2, 3], mass: q(1) }]);
    }
  });

  it("applies finite boundary guards even when the ID normally selects a built-in", () => {
    const finite = (
      outcomes: NonNullable<CertifiedSupplyLaw["outcomes"]>,
    ): readonly CertifiedSupplyLaw[] => [
      { id: "regular-box-v1", kind: "finite", modelVersion: "fixture-v1", outcomes },
    ];
    const cases: readonly [NonNullable<CertifiedSupplyLaw["outcomes"]>, string][] = [
      [[{ pieces: [1, 0, 0], mass: toWire(q(-1)) }], "negative_mass"],
      [[{ pieces: [1, 0, 0], mass: toWire(q(1, 2)) }], "mass_not_one"],
      [[{ pieces: [Number.MAX_SAFE_INTEGER + 1, 0, 0], mass: toWire(q(1)) }], "raw_pieces"],
      [
        Array.from({ length: 25001 }, () => ({ pieces: [0, 0, 0], mass: toWire(q(0)) })),
        "support_limit",
      ],
    ];
    for (const [outcomes, reason] of cases) {
      const laws = finite(outcomes);
      expect(() =>
        getCertifiedLawDistribution({ lawId: "regular-box-v1", count: 1 }, 0, { laws }),
      ).toThrow(reason);
    }
    const laws = finite([{ pieces: [Number.MAX_SAFE_INTEGER, 0, 0], mass: toWire(q(1)) }]);
    expect(getCertifiedLawDistribution({ lawId: "regular-box-v1", count: 1 }, 0, { laws })).toEqual(
      [{ pieces: [Number.MAX_SAFE_INTEGER, 0, 0], mass: q(1) }],
    );
    expect(() =>
      getCertifiedLawDistribution({ lawId: "regular-box-v1", count: 1 }, 0, {
        laws,
        checkBudget: () => {
          throw new Error("caller_budget");
        },
      }),
    ).toThrow("caller_budget");
  });
});

describe("exact documented physical supply laws", () => {
  it("matches precomputed dispatch expectations to exact raw-board enumeration", () => {
    for (const cohort of [0, 1, 2] as const) {
      const expected: [Q, Q, Q] = [ZERO, ZERO, ZERO];
      for (const board of dispatchLaw(cohort)) {
        const [blue, purple, yellow, regular, boxII] = board.raw;
        const gain: [Q, Q, Q] = [
          add(q(blue), add(mul(q(regular), q(12, 5)), mul(q(boxII), q(7, 2)))),
          add(q(purple), add(mul(q(regular), q(1, 5)), mul(q(boxII), q(2, 5)))),
          add(q(yellow), mul(q(boxII), q(1, 5))),
        ];
        for (const color of [0, 1, 2] as const)
          expected[color] = add(expected[color], mul(board.mass, gain[color]));
      }
      expect(getCertifiedLawExpectedGain({ lawId: "dispatch-board-v1", count: 1 }, cohort)).toEqual(
        expected,
      );
    }
  });
  it("enumerates each dispatch cohort independently with exact unit mass", () => {
    for (const cohort of [0, 1, 2] as const) {
      const raw = dispatchLaw(cohort);
      expect(sum(raw.map((row) => row.mass))).toEqual(q(1));
      const expected = getCertifiedLawExpectedGain(
        { lawId: "dispatch-board-v1", count: 1 },
        cohort,
      ).map(toNumber);
      const legacy = [
        DISPATCH_COHORT_EXPECTED_GAIN.noReroll,
        DISPATCH_COHORT_EXPECTED_GAIN.oneReroll,
        DISPATCH_COHORT_EXPECTED_GAIN.twoRerolls,
      ][cohort];
      if (!legacy) throw new Error("legacy_dispatch_cohort_missing");
      expect(expected[0]).toBeCloseTo(legacy.blue, 11);
      expect(expected[1]).toBeCloseTo(legacy.purple, 11);
      expect(expected[2]).toBeCloseTo(legacy.yellow, 11);
    }
  });
  it("keeps integer raw pieces and exact joint color probabilities", () => {
    const law = getCertifiedLawDistribution({ lawId: "box-ii-v1", count: 12 }, 0);
    expect(law).toHaveLength(91);
    expect(sum(law.map((row) => row.mass))).toEqual(q(1));
    expect(law.every((row) => row.pieces.every(Number.isInteger))).toBe(true);
    expect(law.some((row) => row.pieces.every((n) => n === 0))).toBe(false);
    expect(getCertifiedLawExpectedGain({ lawId: "box-ii-v1", count: 12 }, 0)).toEqual([
      q(42),
      q(24, 5),
      q(12, 5),
    ]);
  });
  it("resolves finite laws by the same latent cohort supplied for every event", () => {
    const laws: readonly CertifiedSupplyLaw[] = [
      {
        id: "latent",
        kind: "finite",
        modelVersion: "fixture-v1",
        outcomesByCohort: [
          [{ pieces: [10, 0, 0], mass: toWire(q(1)) }],
          [{ pieces: [0, 10, 0], mass: toWire(q(1)) }],
          [{ pieces: [0, 0, 10], mass: toWire(q(1)) }],
        ],
      },
    ];
    expect(getCertifiedLawDistribution({ lawId: "latent", count: 2 }, 0, { laws })).toEqual([
      { pieces: [20, 0, 0], mass: q(1) },
    ]);
    expect(getCertifiedLawDistribution({ lawId: "latent", count: 2 }, 2, { laws })).toEqual([
      { pieces: [0, 0, 20], mass: q(1) },
    ]);
  });
  it("cooperatively checks the caller budget and rejects malformed laws", () => {
    expect(() =>
      getCertifiedLawDistribution({ lawId: "box-ii-v1", count: 30 }, 0, {
        checkBudget: () => {
          throw new Error("caller_budget");
        },
      }),
    ).toThrow("caller_budget");
    expect(() =>
      getCertifiedLawDistribution({ lawId: "bad", count: 1 }, 0, {
        laws: [
          {
            id: "bad",
            kind: "finite",
            modelVersion: "fixture",
            outcomes: [{ pieces: [1, 0, 0], mass: toWire(q(1, 2)) }],
          },
        ],
      }),
    ).toThrow("mass_not_one");
    expect(() => getCertifiedLawDistribution({ lawId: "box-ii-v1", count: 0.5 }, 0)).toThrow(
      "count_invalid",
    );
  });
});
