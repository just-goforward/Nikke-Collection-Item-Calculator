import { readFileSync } from "node:fs";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCertifiedSupplySnapshot } from "../shared/certifiedSupply.ts";
import { CERTIFIED_WASM_HASH } from "../shared/generated/certifiedWasmBuild.ts";
import { assertProperty, type PropertyIdentity } from "../shared/propertyHarness.ts";
import type { CertifiedInput, CertifiedOutput, Triple } from "../src/certified/types.ts";
import { loadCertifiedWasm } from "../src/certified/wasmBackend.ts";
import { solveCertifiedWasm } from "../src/certified/wasmSolver.ts";
import { q, wire } from "./certified-staging-oracle.ts";
import { type LaneReport, verifyCertifiedLane } from "./certified-staging-oracle-lane.ts";

/* S2/P1. Committed Rust/WASM (via src/certified/wasmBackend) against the
 * independent staging lane (scripts/certified-staging-oracle*.ts and four-cohort
 * pricing). FiniteKernel/solveCertified are never used. The lane compares exact
 * P/B/C, the consumed vector, the optimal-action mask (all exact ties), kit,
 * status and batch; waiting is asserted exactly only on its day-0 path (no
 * snapshot arrivals) and on the cohort-0 H56 witness fixture. The 2000-case
 * staging panel is not touched. */

const IDENTITY: PropertyIdentity = {
  file: "scripts/certified-wasm-oracle.property.spec.ts",
  generatorSource: readFileSync("scripts/certified-wasm-oracle.property.spec.ts", "utf8"),
  sources: {
    "src/certified/wasmBackend.ts": readFileSync("src/certified/wasmBackend.ts", "utf8"),
    "src/certified/wasmSolver.ts": readFileSync("src/certified/wasmSolver.ts", "utf8"),
    "scripts/certified-staging-oracle-lane.ts": readFileSync(
      "scripts/certified-staging-oracle-lane.ts",
      "utf8",
    ),
  },
  extra: { certifiedWasmSha256: CERTIFIED_WASM_HASH },
};
const NUM_RUNS = 25;
const TIME_LIMIT_MS = 45_000;
const HARD_DEADLINE_MS = 60_000;
const AS_OF = "2026-09-30T04:00:00.000Z";

let module: WebAssembly.Module;
beforeAll(async () => {
  module = await loadCertifiedWasm(async () => readFileSync("public/certified_solver.wasm"));
});
const baseSnapshot = buildCertifiedSupplySnapshot({
  asOf: AS_OF,
  revision: "wasm-oracle-property",
  sourceHash: "a".repeat(64),
  soloPeriods: [],
  collaborationPeriods: [],
  sourceStatus: "healthy",
});

type Spec = {
  grade: "R" | "SR";
  level: number;
  exp: number;
  stock: Triple;
  basis?: Triple;
  /** Integer prior numerators for cohorts 0..3; cohort 3 positive. Absent = default 1:2:3:1. */
  priors?: readonly [number, number, number, number];
  events?: CertifiedInput["snapshot"]["events"];
};
function input(spec: Spec): CertifiedInput {
  const snapshot = structuredClone(baseSnapshot);
  snapshot.events = spec.events ?? [];
  const priors = spec.priors;
  const total = priors ? priors[0] + priors[1] + priors[2] + priors[3] : 0;
  return {
    grade: spec.grade,
    level: spec.level,
    exp: spec.exp,
    stock: spec.stock,
    asOf: AS_OF,
    snapshot,
    ...(spec.basis ? { priceBasisStock: spec.basis } : {}),
    ...(priors
      ? {
          cohortWeights: [
            wire(q(priors[0], total)),
            wire(q(priors[1], total)),
            wire(q(priors[2], total)),
            wire(q(priors[3], total)),
          ] as const,
        }
      : {}),
  };
}

type Tally = {
  cases: number;
  apiCompleted: number;
  apiPartial: number;
  apiRefused: number;
  lanePass: number;
  laneNotrun: number;
  laneFail: number;
  exactCurrent: Set<string>;
  waiting: Record<string, number>;
  notrunReasons: Record<string, number>;
};
const tally: Tally = {
  cases: 0,
  apiCompleted: 0,
  apiPartial: 0,
  apiRefused: 0,
  lanePass: 0,
  laneNotrun: 0,
  laneFail: 0,
  exactCurrent: new Set(),
  waiting: {},
  notrunReasons: {},
};
function check(spec: Spec): { output: CertifiedOutput; report: LaneReport } {
  const request = input(spec);
  const output = solveCertifiedWasm(module, request);
  const report = verifyCertifiedLane(request, output);
  tally.cases++;
  if (output.status === "completed") tally.apiCompleted++;
  else if (output.status === "partial") tally.apiPartial++;
  else tally.apiRefused++;
  if (report.status === "PASS") tally.lanePass++;
  else if (report.status === "NOTRUN") tally.laneNotrun++;
  else tally.laneFail++;
  if (report.current.status === "PASS") tally.exactCurrent.add(JSON.stringify(spec));
  const waitingKey = `${report.waiting.status}:${report.waiting.reason}`;
  tally.waiting[waitingKey] = (tally.waiting[waitingKey] ?? 0) + 1;
  for (const part of [report.api, report.pricing, report.current, report.batch])
    if (part.status === "NOTRUN")
      tally.notrunReasons[part.reason] = (tally.notrunReasons[part.reason] ?? 0) + 1;
  return { output, report };
}

const specArbitrary: fc.Arbitrary<Spec> = fc
  .record({
    grade: fc.constantFrom<"R" | "SR">("R", "SR"),
    level: fc.integer({ min: 0, max: 15 }),
    expStep: fc.nat({ max: 29 }),
    stock: fc.tuple(fc.nat({ max: 80 }), fc.nat({ max: 60 }), fc.nat({ max: 40 })),
    basis: fc.option(fc.tuple(fc.nat({ max: 80 }), fc.nat({ max: 60 }), fc.nat({ max: 40 })), {
      nil: undefined,
    }),
    priors: fc.option(
      fc.tuple(
        fc.nat({ max: 6 }),
        fc.nat({ max: 6 }),
        fc.nat({ max: 6 }),
        fc.integer({ min: 1, max: 6 }),
      ),
      { nil: undefined },
    ),
  })
  .map(({ grade, level, expStep, stock, basis, priors }) => ({
    grade,
    level,
    exp: level === 15 ? 0 : (expStep % (grade === "R" ? 10 : 30)) * 100,
    stock,
    ...(basis ? { basis } : {}),
    ...(priors ? { priors } : {}),
  }));

/** One dispatch-board-v1 arrival `day` game days after the current day. */
function dispatchArrival(day: number): NonNullable<Spec["events"]> {
  const rule = baseSnapshot.rules[0];
  if (!rule) throw new Error("snapshot_rule_missing");
  const date = new Date(Date.parse("2026-09-30T00:00:00Z") + day * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return [
    {
      id: `dispatch:${date}`,
      gameDate: date,
      at: `${date}T08:00:00.000Z`,
      kind: "dispatch",
      status: "confirmed",
      ruleId: rule.id,
      refs: [{ lawId: "dispatch-board-v1", count: 1 }],
    },
  ];
}

// Exact multi-kit ties: a WASM-only scan of ~1000 real-game states/stocks (all
// grades/levels, exp sampled, six stock vectors) found no mask with two or more
// kits, because recurring rates make the three prices pairwise different. The
// tie contract is therefore exercised by exact mask equality on every case and
// by the STOP/no-kit (mask 0) fixtures below.
const FIXTURES: readonly (readonly [
  string,
  Spec,
  Partial<Record<"mask" | "waitingDays", number>>,
])[] = [
  ["SR14 boundary, blue only", { grade: "SR", level: 14, exp: 0, stock: [20, 0, 0] }, { mask: 1 }],
  [
    "SR15 terminal complete (mask 0)",
    { grade: "SR", level: 15, exp: 0, stock: [0, 0, 0] },
    { mask: 0 },
  ],
  [
    "R0 zero stock preserve (mask 0)",
    { grade: "R", level: 0, exp: 0, stock: [0, 0, 0] },
    { mask: 0 },
  ],
  [
    "SR4 unusable yellow-only STOP (mask 0)",
    { grade: "SR", level: 4, exp: 0, stock: [0, 0, 10] },
    { mask: 0 },
  ],
  [
    "R14 exp900 promotion boundary",
    { grade: "R", level: 14, exp: 900, stock: [10, 10, 10] },
    { mask: 1 },
  ],
  [
    "SR14 exp2900 remainder-9 stock",
    { grade: "SR", level: 14, exp: 2900, stock: [19, 19, 19] },
    { mask: 1 },
  ],
  ["R15 equals SR5", { grade: "R", level: 15, exp: 0, stock: [30, 30, 30] }, { mask: 4 }],
  [
    "cohort-3-only priors",
    { grade: "SR", level: 14, exp: 0, stock: [0, 0, 0], priors: [0, 0, 0, 1] },
    { mask: 0 },
  ],
  [
    "H56 cohort-0 witness, empty stock",
    { grade: "SR", level: 14, exp: 0, stock: [0, 0, 0], events: dispatchArrival(56) },
    { waitingDays: 56 },
  ],
  [
    "H56 cohort-0 witness, one blue use",
    { grade: "SR", level: 14, exp: 0, stock: [10, 0, 0], events: dispatchArrival(56) },
    { waitingDays: 56 },
  ],
];

describe("P1 Rust/WASM vs independent staging oracle", () => {
  it.each(FIXTURES)("named fixture: %s", (_name, spec, expected) => {
    const { output, report } = check(spec);
    expect(report).toMatchObject({
      status: "PASS",
      pricing: { status: "PASS" },
      current: { status: "PASS" },
      batch: { status: "PASS" },
      waiting: { status: "PASS" },
    });
    if (expected.mask !== undefined) expect(output.current?.optimalActionMask).toBe(expected.mask);
    if (expected.waitingDays === 56) {
      expect(output.waiting.recommendedDays).toBe(56);
      expect(output.waiting.strictBoundaryWitness?.cohort).toBe(0);
      expect(report.waiting.reason).toBe(
        "independent_exact_finite_endpoints_and_strict_lex_improvement",
      );
    } else {
      expect(output.waiting.recommendedDays).toBe(0);
    }
  });

  it("classifies an interior waiting day as NOTRUN while still comparing current exactly", () => {
    const { output, report } = check({
      grade: "SR",
      level: 14,
      exp: 0,
      stock: [0, 0, 0],
      events: dispatchArrival(30),
    });
    expect(output.status).toBe("completed");
    expect(output.waiting.recommendedDays).toBe(30);
    expect(report).toMatchObject({
      status: "NOTRUN",
      current: { status: "PASS" },
      waiting: {
        status: "NOTRUN",
        reason: "independent_full_expectation_for_interior_day_not_computed",
      },
    });
  });

  it(
    "matches exact pricing, current, ties, batch and day-0 waiting on generated in-domain inputs",
    async () => {
      await assertProperty(
        fc.property(specArbitrary, (spec) => {
          const { report } = check(spec);
          if (report.status === "FAIL") throw new Error(`lane_FAIL ${JSON.stringify(report)}`);
          return true;
        }),
        { name: "P1.lane", numRuns: NUM_RUNS, timeLimitMs: TIME_LIMIT_MS, identity: IDENTITY },
      );
    },
    HARD_DEADLINE_MS,
  );

  it("executed at least 25 distinct exact current comparisons and no lane FAIL", () => {
    console.info(
      `[P1 tally] ${JSON.stringify({ ...tally, exactCurrent: tally.exactCurrent.size })}`,
    );
    expect(tally.laneFail).toBe(0);
    expect(tally.exactCurrent.size).toBeGreaterThanOrEqual(25);
  });
});
