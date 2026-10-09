import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { CertifiedValue } from "../src/certified/types.ts";
import {
  frozenApprovedSnapshot,
  independentApprovedPricing,
} from "./certified-staging-approved-panel.ts";
import {
  add,
  cmp,
  compareValue,
  createOracleEvaluator,
  fromWire,
  type OracleInput,
  type OracleValue,
  type QTriple,
  q,
  type Triple,
} from "./certified-staging-oracle.ts";
import {
  createIndependentEndpointIntegerEvaluator,
  independentFiniteWitnessInteger,
} from "./certified-staging-oracle-endpoints-integer.ts";
import { makeTriple } from "./certified-staging-oracle-tuples.ts";
import {
  type FrozenPilotEndpointRow,
  loadFrozenPilotEndpoints,
} from "./certified-staging-pilot-endpoint-fixture.ts";

type Result = OracleValue & { consumed: QTriple };
function identical(first: Result, second: Result): boolean {
  return (
    compareValue(first, second) === 0 &&
    first.consumed.every((value, color) => {
      const expected = second.consumed[color];
      assert(expected, "Expected matching consumption coordinate");
      return cmp(value, expected) === 0;
    })
  );
}
function savedValue(value: CertifiedValue): Result {
  return {
    P: fromWire(value.successP),
    B: fromWire(value.weightedExpectedConsumptionB),
    C: fromWire(value.expectedTotalConsumptionC),
    consumed: makeTriple((color) => fromWire(value.expectedConsumed[color])),
  };
}
function smallStocks(): Triple[] {
  const result: Triple[] = [];
  for (let blue = 0; blue <= 2; blue++)
    for (let purple = 0; purple <= 2; purple++)
      for (let yellow = 0; yellow <= 2; yellow++)
        result.push([blue * 10 + 1, purple * 10 + 4, yellow * 10 + 9]);
  return result;
}
function smallCases(prices: QTriple): OracleInput[] {
  const result: OracleInput[] = [];
  for (const grade of ["R", "SR"] as const)
    for (let level = 0; level < 15; level++)
      for (const stock of smallStocks()) result.push({ grade, level, exp: 0, stock, prices });
  for (const exp of [2400, 2700, 2900])
    for (const stock of [
      [10, 10, 10],
      [20, 20, 20],
      [50, 0, 0],
      [9, 10, 19],
    ] as const)
      result.push({ grade: "SR", level: 14, exp, stock, prices });
  result.push({ grade: "SR", level: 15, exp: 0, stock: [29, 44, 79], prices });
  let random = 0x9a302027;
  for (let index = 0; index < 80; index++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    result.push({
      grade: index % 2 ? "R" : "SR",
      level: random % 15,
      exp: 0,
      stock: [random % 60, (random >>> 6) % 30, (random >>> 12) % 30],
      prices,
    });
  }
  return result;
}
function posteriorPrices(): QTriple[] {
  const snapshot = frozenApprovedSnapshot();
  const priors = [
    [q(1), q(0), q(0)],
    [q(0), q(1), q(0)],
    [q(0), q(0), q(1)],
    [q(1, 3), q(1, 3), q(1, 3)],
    [q(1, 5), q(1, 2), q(3, 10)],
    [q(0), q(2, 3), q(1, 3)],
  ] as const;
  return priors.map((prior) => {
    const rates = independentApprovedPricing(snapshot, prior);
    return makeTriple((color) => {
      const sum = add(q(([100, 50, 20] as const)[color]), rates[color]);
      return q(sum.d, sum.n);
    });
  });
}
const priceFamilies: QTriple[] = [
  [q(1, 21), q(1, 3), q(10, 13)],
  [q(1, 300), q(1, 20), q(1)],
  [q(1), q(1), q(1)],
  ...posteriorPrices(),
];
it("keeps all nine original price families and all 8,127 endpoint comparisons", () => {
  expect(priceFamilies).toHaveLength(9);
  expect(priceFamilies.map((prices) => smallCases(prices).length)).toEqual(Array(9).fill(903));
});

// Keep every original input and equality criterion. The runner's 60s watchdog
// applies per price family rather than to all 8,127 independent comparisons.
it.each(priceFamilies.map((prices, family) => ({ prices, family })))(
  "matches reduced rational uncapped DP on all 903 original inputs of price family $family",
  ({ prices }) => {
    let checked = 0;
    const reduced = createOracleEvaluator(prices);
    const integer = createIndependentEndpointIntegerEvaluator(prices);
    for (const input of smallCases(prices)) {
      expect(
        identical(integer(input), reduced(input)),
        JSON.stringify({ grade: input.grade, level: input.level, stock: input.stock }),
      ).toBe(true);
      checked++;
    }
    expect(checked).toBe(903);
  },
  60000,
);

function attempt(row: FrozenPilotEndpointRow, rates: QTriple) {
  const witness = row.output.waiting.strictBoundaryWitness;
  assert(witness, "Expected pilot endpoint witness");
  const prices = makeTriple((color) =>
    q(rates[color].d, BigInt(row.input.stock[color]) * rates[color].d + rates[color].n),
  );
  const start = performance.now(),
    memoryBefore = process.memoryUsage();
  const budget = { maxMemoEntries: 10000, deadlineAt: performance.now() + 5000 };
  try {
    const before = independentFiniteWitnessInteger(
      { ...row.input, stock: witness.beforeStock, prices },
      budget,
    );
    const after = independentFiniteWitnessInteger(
      { ...row.input, stock: witness.afterStock, prices },
      budget,
    );
    const matches =
      identical(before, savedValue(witness.beforeValue)) &&
      identical(after, savedValue(witness.afterValue)) &&
      compareValue(after, before) > 0;
    return {
      id: row.id,
      status: matches ? "PASS" : "FAIL",
      reason: matches ? "exact_both_PBC_vectors_and_strictness" : "exact_endpoint_mismatch",
      elapsedMs: performance.now() - start,
      nodes: before.nodes + after.nodes,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      id: row.id,
      status: reason.startsWith("independent_endpoint_") ? "NOTRUN" : "FAIL",
      reason,
      elapsedMs: performance.now() - start,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
    };
  }
}
it("replays the six preserved pilot NOTRUN endpoints under the unchanged paired5s and per-evaluator10k guards", () => {
  const pilot = loadFrozenPilotEndpoints();
  const rates = independentApprovedPricing(frozenApprovedSnapshot(), [q(1, 3), q(1, 3), q(1, 3)]);
  const rows = pilot.rows.map((row) => attempt(row, rates));
  const sourcePaths = [
    "scripts/certified-staging-oracle-endpoints-integer.ts",
    "scripts/certified-staging-oracle-endpoints-integer.spec.ts",
    "scripts/certified-staging-oracle.ts",
    "scripts/certified-staging-oracle-tuples.ts",
    "scripts/certified-staging-oracle-witness.ts",
    "scripts/certified-staging-approved-panel.ts",
    "scripts/certified-staging-approved-panel/snapshot.json",
    "scripts/certified-staging-approved-panel/independent-physical-cohorts.json",
    "scripts/certified-staging-pilot-endpoint-fixture.ts",
    pilot.provenance.fixture.path,
    pilot.provenancePath,
    "shared/game.ts",
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    pilotPath: pilot.provenance.original.path,
    pilotSha256: pilot.provenance.original.sha256,
    pilotFixture: pilot.provenance.fixture,
    pilotSelection: pilot.provenance.selectedIds,
    sources: sourcePaths.map((path) => ({
      path,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    })),
    pass: rows.filter((row) => row.status === "PASS").length,
    fail: rows.filter((row) => row.status === "FAIL").length,
    notRun: rows.filter((row) => row.status === "NOTRUN").length,
    budget: {
      pairedElapsedMs: 5000,
      perEndpointMemoEntries: 10000,
      maxStockUnitsBeforePowerAllocation: 600,
    },
    processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    scope:
      "Independent exact integer endpoint DP; same uncapped public recurrence, complete feasible unrestricted policy required, strictP1 pruning only. Saved current profile outputs, not a new candidate call or browser timing. Pilot original report stays immutable; proof time/RSS separate from solver15s. No candidate solver/transitions/bounds/pages imported.",
    rows,
  };
  const path =
    "benchmarks/results/certified-staging-validation-pilot20-endpoint-integer-replay-" +
    Date.now() +
    ".json";
  mkdirSync("benchmarks/results", { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({ report: path, pass: report.pass, fail: report.fail, notRun: report.notRun }),
  );
  expect(rows).toHaveLength(6);
  expect(report.fail).toBe(0);
}, 40000);
