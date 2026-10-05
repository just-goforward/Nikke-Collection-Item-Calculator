import { describe, expect, it } from "vitest";
import { add, mul, q, sum, toNumber, toWire, ZERO } from "./certifiedRational.ts";
import {
  type CertifiedSupplyLaw,
  dispatchLaw,
  getCertifiedLawDistribution,
  getCertifiedLawExpectedGain,
} from "./certifiedSupplyLaws.ts";
import { DISPATCH_COHORT_EXPECTED_GAIN } from "./supplyForecastModel.ts";

describe("exact documented physical supply laws", () => {
  it("matches precomputed dispatch expectations to exact raw-board enumeration", () => {
    for (const cohort of [0, 1, 2] as const) {
      const expected = [ZERO, ZERO, ZERO];
      for (const board of dispatchLaw(cohort)) {
        const [blue, purple, yellow, regular, boxII] = board.raw;
        const gain = [
          add(q(blue), add(mul(q(regular), q(12, 5)), mul(q(boxII), q(7, 2)))),
          add(q(purple), add(mul(q(regular), q(1, 5)), mul(q(boxII), q(2, 5)))),
          add(q(yellow), mul(q(boxII), q(1, 5))),
        ];
        for (let color = 0; color < 3; color += 1)
          expected[color] = add(expected[color]!, mul(board.mass, gain[color]!));
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
      ][cohort]!;
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
