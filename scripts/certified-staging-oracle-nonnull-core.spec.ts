import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  authenticateHistoricalArchive,
  readV2Evidence,
  V2_ROOT,
} from "./certified-staging-approved-panel/v2/evidence.ts";
import {
  add,
  fromWire,
  type OracleInput,
  type OracleResult,
  q,
  solveOracle,
} from "./certified-staging-oracle.ts";
import { independentCurrentCoverage } from "./certified-staging-oracle-current-coverage.ts";
import {
  expectedFixtureConsumptionCost,
  generateValidationCases,
} from "./certified-staging-oracle-fixtures.ts";
import { solveIntegerOracle } from "./certified-staging-oracle-integer.ts";
import { independentLargeCappedOracle } from "./certified-staging-oracle-large-capped.ts";
import { independentLargeIntegerOracle } from "./certified-staging-oracle-large-integer.ts";
import { mapTriple } from "./certified-staging-oracle-tuples.ts";

const input = (patch: Partial<OracleInput> = {}): OracleInput => ({
  grade: "SR",
  level: 14,
  exp: 2900,
  stock: [10, 10, 10],
  prices: [q(1, 10), q(1, 10), q(1, 10)],
  ...patch,
});
const solvers = [
  {
    name: "integer",
    solve: (value: OracleInput, check: (n: number) => void = () => {}) => {
      void check;
      return solveIntegerOracle(value);
    },
  },
  {
    name: "large-integer",
    solve: (value: OracleInput, check: (n: number) => void = () => {}) =>
      independentLargeIntegerOracle(value, { maxMemoEntries: 50000, check }),
  },
  {
    name: "large-capped",
    solve: (value: OracleInput, check: (n: number) => void = () => {}) =>
      independentLargeCappedOracle(value, { maxMemoEntries: 50000, check }),
  },
] as const;
function values(result: OracleResult) {
  return [result.P, result.B, result.C, result.consumed, result.action, result.ties];
}
function exception(call: () => unknown) {
  try {
    call();
    return null;
  } catch (error) {
    return error instanceof Error ? [error.name, error.message] : error;
  }
}

it("uses all three bounded tuple indices and retains exact terminal, STOP and tied actions", () => {
  for (const { solve } of solvers) {
    expect(values(solve(input()))).toEqual([
      q(1),
      q(1),
      q(10),
      [q(10), q(0), q(0)],
      "blue",
      ["blue", "purple", "yellow"],
    ]);
    for (const stock of [
      [10, 0, 0],
      [0, 10, 0],
      [0, 0, 10],
    ] as const) {
      const color = stock.findIndex((pieces) => pieces > 0);
      const result = solve(input({ stock }));
      expect(result.P).toEqual(q(1));
      expect(result.consumed).toEqual(stock.map((pieces) => q(pieces)));
      expect(result.action).toBe(["blue", "purple", "yellow"][color]);
    }
    expect(values(solve(input({ stock: [0, 0, 0] })))).toEqual([
      q(0),
      q(0),
      q(0),
      [q(0), q(0), q(0)],
      "STOP",
      ["STOP"],
    ]);
    expect(values(solve(input({ level: 15, exp: 0, stock: [300, 0, 0] })))).toEqual([
      q(1),
      q(0),
      q(0),
      [q(0), q(0), q(0)],
      "DONE",
      ["DONE"],
    ]);
  }
});

it("covers every grade boundary against independent reduced rational Bellman arithmetic", () => {
  for (const { solve } of solvers) {
    for (const grade of ["R", "SR"] as const) {
      for (const level of [0, 4, 5, 9, 10, 14, 15]) {
        let exp = 0;
        if (level !== 15) exp = grade === "R" ? 900 : 2900;
        const value = input({
          grade,
          level,
          exp,
          stock: [39, 27, 18],
          prices: [q(7, 211), q(7, 203), q(7, 147)],
        });
        expect(values(solve(value))).toEqual(values(solveOracle(value)));
      }
    }
  }
  const capped = input({ stock: [600, 200, 100] });
  expect(values(solvers[2].solve(capped))).toEqual(values(solvers[1].solve(capped)));
  for (const { solve } of solvers.slice(1))
    expect(solve(input({ level: 15, exp: 0, stock: [1500, 0, 0] })).P).toEqual(q(1));
});

it("preserves baseline admission errors, native malformed errors and callback propagation", () => {
  expect(exception(() => solveIntegerOracle(input({ stock: [310, 0, 0] })))).toEqual([
    "Error",
    "Original uncapped oracle contract permits at most30 uses",
  ]);
  expect(exception(() => solvers[1].solve(input({ stock: [1510, 0, 0] })))).toEqual([
    "Error",
    "large_oracle_admission_max150_initial_uses",
  ]);
  expect(exception(() => solvers[2].solve(input({ stock: [1510, 0, 0] })))).toEqual([
    "Error",
    "independent_public_cap_admission_max150_initial_uses",
  ]);
  for (const { solve } of solvers) {
    expect(
      exception(() => Reflect.apply(solve, undefined, [{ ...input(), prices: [q(1), q(1)] }])),
    ).toEqual(["TypeError", "Cannot read properties of undefined (reading 'n')"]);
    expect(exception(() => solve(input({ prices: [{ n: 1n, d: 0n }, q(1), q(1)] })))).toEqual([
      "RangeError",
      "Division by zero",
    ]);
  }
  for (const { solve } of solvers.slice(1)) {
    const effects: number[] = [];
    expect(
      exception(() =>
        solve(input({ level: 13 }), (entries) => {
          effects.push(entries);
          throw new RangeError("callback sentinel");
        }),
      ),
    ).toEqual(["RangeError", "callback sentinel"]);
    expect(effects).toEqual([0]);
  }
});

it("keeps missing powers optional until native arithmetic or the original q decoder consumes them", () => {
  for (const { name, solve } of solvers) {
    for (const [fixture, message] of [
      [
        input({ stock: [0, 10, -10] }),
        "Cannot mix BigInt and other types, use explicit conversions",
      ],
      [input({ level: 15, exp: 0, stock: [-10, 0, 0] }), "Cannot convert undefined to a BigInt"],
    ] as const) {
      const callbacks: number[] = [];
      expect(exception(() => solve(fixture, (entries) => callbacks.push(entries)))).toEqual([
        "TypeError",
        message,
      ]);
      expect(callbacks).toEqual(name === "integer" ? [] : [0]);
    }
  }
});

it("retains the baseline's complete seeded fixture identity and all modulo/callback domains", () => {
  const fixtures = generateValidationCases();
  expect(fixtures).toHaveLength(2000);
  const serialized = JSON.stringify(fixtures, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  // Derived from the independently materialized baseline, not current output.
  expect(createHash("sha256").update(serialized).digest("hex")).toBe(
    "86aacbe305985bcddf89fd284f5f39ec95dc0a67a7113919f981ee623ea53567",
  );
  expect(new Set(fixtures.map((row) => row.semanticKey)).size).toBe(2000);
  for (const row of fixtures) {
    expect(row.cohortWeights.reduce(add, q(0))).toEqual(q(1));
    for (const event of row.future) {
      expect([1, 2, 7, 55, 56]).toContain(event.day);
      expect(event.byCohort).toHaveLength(3);
      for (const cohort of event.byCohort)
        expect(cohort.reduce((total, outcome) => add(total, outcome.probability), q(0))).toEqual(
          q(1),
        );
    }
  }
  expect(generateValidationCases(0)).toEqual([]);
  expect(expectedFixtureConsumptionCost([1, 2, 3], [q(1, 2), q(1, 3), q(1, 5)])).toEqual(q(53, 30));
  const reads: string[] = [];
  const prices = new Proxy([q(1, 2), q(1, 3), q(1, 5)] as const, {
    get(target, key, receiver) {
      reads.push(String(key));
      return Reflect.get(target, key, receiver);
    },
  });
  expectedFixtureConsumptionCost([1, 2, 3], prices);
  expect(reads).toEqual(["0", "1", "2"]);
});

it("preserves the baseline's native failures on all negative-stock lifted paths", () => {
  for (const blue of [-10, -100, -1000, -1500]) {
    for (const purple of [0, 10, 20, 30, 40, 50, 60]) {
      const callbacks: number[] = [];
      expect(
        exception(() =>
          independentLargeCappedOracle(
            input({
              exp: 0,
              stock: [blue, purple, 0],
            }),
            {
              maxMemoEntries: 50000,
              check(entries) {
                callbacks.push(entries);
              },
            },
          ),
        ),
      ).toEqual(["TypeError", "Cannot mix BigInt and other types, use explicit conversions"]);
      expect(callbacks).toEqual([0]);
    }
  }
});

it("preserves fourth and sparse external fixture coordinates and count-before-price evaluation", () => {
  const extendedPieces = [1, 2, 3, 4];
  const extendedPrices = [q(1, 2), q(1, 3), q(1, 5), q(1, 7)];
  expect(
    Reflect.apply(expectedFixtureConsumptionCost, undefined, [extendedPieces, extendedPrices]),
  ).toEqual(q(491, 210));
  const sparsePieces = Object.assign(new Array<number>(4), { 3: 4 });
  expect(
    Reflect.apply(expectedFixtureConsumptionCost, undefined, [sparsePieces, extendedPrices]),
  ).toEqual(q(4, 7));
  const reads: string[] = [];
  const prices = new Proxy([q(1, 2), q(1, 3), q(1, 5)] as const, {
    get(target, key, receiver) {
      reads.push(String(key));
      return Reflect.get(target, key, receiver);
    },
  });
  expect(
    exception(() =>
      Reflect.apply(expectedFixtureConsumptionCost, undefined, [sparsePieces, prices]),
    ),
  ).toEqual(["TypeError", "Cannot read properties of undefined (reading 'n')"]);
  expect(reads).toEqual(["3"]);
  reads.length = 0;
  const coercingPieces = [
    1,
    2,
    3,
    {
      valueOf() {
        reads.push("fourth-count");
        return 4;
      },
    },
  ];
  expect(
    exception(() =>
      Reflect.apply(expectedFixtureConsumptionCost, undefined, [coercingPieces, prices]),
    ),
  ).toEqual(["TypeError", "Cannot read properties of undefined (reading 'n')"]);
  expect(reads).toEqual(["0", "1", "2", "fourth-count", "3"]);
});

it("retains fourth-coordinate NaN comparisons and skips sparse stock coordinates", () => {
  const denseFourth = [1000, 1000, 1000, 0];
  const sparseFourth = Object.assign(new Array<number>(4), {
    0: 1000,
    1: 1000,
    2: 1000,
  });
  const sparseInterior = Object.assign(new Array<number>(4), {
    0: 1000,
    2: 1000,
    3: 0,
  });
  for (const stock of [denseFourth, sparseInterior]) {
    expect(
      Reflect.apply(independentCurrentCoverage, undefined, [{ ...input({ level: 13 }), stock }]),
    ).toEqual({
      basis:
        "NOTRUN_expanded_stock_without_independent_feasible_unrestricted_or_recorded_finite_proof",
    });
  }
  const coverage = Reflect.apply(independentCurrentCoverage, undefined, [
    { ...input({ level: 13 }), stock: sparseFourth },
  ]);
  expect(coverage.basis).toBe(
    "independent_unrestricted_optimum_all_tied_complete_policies_feasible",
  );
  expect(coverage.result?.P).toEqual(q(1));
  expect(coverage.result?.action).toBe("yellow");
});

it("keeps provenance sealed and proves unrestricted current coverage without cache writes", () => {
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  authenticateHistoricalArchive();
  readV2Evidence();
  expect(hash(`${V2_ROOT}/historical/certified-staging-oracle.ts.txt`)).toBe(
    "b92f50315a31d6b0f5e04054f5d220cf3103ef76b1d4a7c4d557da0a7964823b",
  );
  expect(hash(`${V2_ROOT}/historical/certified-staging-oracle-physical-supply.ts.txt`)).toBe(
    "68686624ac22ab517283347c3cce7abb9a04d269eb2acb8b9ad3a63e8d5f13b5",
  );
  expect(hash("scripts/certified-staging-approved-panel/independent-physical-cohorts.json")).toBe(
    "fed3faab0a2b032deb65f9b892684cb9518c38a67596f8ba066f8e9cc7d8be0a",
  );
  expect(hash("scripts/certified-staging-approved-panel/provenance.json")).toBe(
    "6cbf971ecdcbfe1e728a543a1a76adfa87ebbf694ae1722de5a2c6380b29d94a",
  );
  const result = independentCurrentCoverage(input({ level: 13, stock: [1000, 1000, 1000] }));
  expect(result.basis).toBe("independent_unrestricted_optimum_all_tied_complete_policies_feasible");
  expect(result.result?.P).toEqual(q(1));
  expect(result.result?.B).toEqual(q(7, 5));
  expect(result.result?.C).toEqual(q(14));
  expect(result.result?.action).toBe("yellow");
  expect(result.result?.ties).toEqual(["yellow"]);
});

it("matches sealed recorded prices including equivalent exact representations, but not price drift", () => {
  type Wire = Parameters<typeof fromWire>[0];
  type WireTriple = readonly [Wire, Wire, Wire];
  const path = "scripts/certified-staging-oracle-fixtures/large-current-R600.json.txt";
  const bytes = readFileSync(path);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "01ba9e5a1a45f21c4f17f9c90c6b1c60955494a72658118f5fda528113788aae",
  );
  const proof = JSON.parse(bytes.toString()) as {
    input: Omit<OracleInput, "prices"> & { prices: WireTriple };
    result: {
      P: Wire;
      B: Wire;
      C: Wire;
      consumed: WireTriple;
      action: OracleResult["action"];
      ties: OracleResult["ties"];
    };
  };
  const value: OracleInput = { ...proof.input, prices: mapTriple(proof.input.prices, fromWire) };
  const expected = [
    fromWire(proof.result.P),
    fromWire(proof.result.B),
    fromWire(proof.result.C),
    mapTriple(proof.result.consumed, fromWire),
    proof.result.action,
    proof.result.ties,
  ];
  for (const prices of [
    value.prices,
    mapTriple(value.prices, (price) => ({ n: price.n * 2n, d: price.d * 2n })),
  ]) {
    const coverage = independentCurrentCoverage({ ...value, prices });
    expect(coverage.basis).toBe("immutable_uncapped_expanded_layered_exact_proof");
    expect(coverage.result && values(coverage.result)).toEqual(expected);
  }
  const drifted = independentCurrentCoverage({
    ...value,
    prices: [{ ...value.prices[0], n: value.prices[0].n + 1n }, value.prices[1], value.prices[2]],
  });
  expect(drifted.result).toBeUndefined();
  expect(drifted.basis).toBe(
    "NOTRUN_expanded_stock_without_independent_feasible_unrestricted_or_recorded_finite_proof",
  );
});
