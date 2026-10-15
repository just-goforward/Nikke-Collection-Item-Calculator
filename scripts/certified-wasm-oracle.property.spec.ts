import { readFileSync } from "node:fs";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildCertifiedSupplySnapshot,
  isCertifiedEventClaimable,
} from "../shared/certifiedSupply.ts";
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
 * status and batch. Supply rules v3 (certified-daily-v3): every snapshot keeps its
 * Wednesday 05:00 KST weekly grants (deterministic 10,10,0), the grant already
 * claimable at asOf is passed as received, and the recommended-day horizon is 14.
 * Waiting is asserted exactly on day 0 (current equals the unrestricted optimum)
 * and on cohort-0 H14 boundary witnesses. The 2000-case staging panel is not
 * touched. */

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
const WAITING_RUNS = 12;
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
const weeklyEvents = baseSnapshot.events.filter((event) => event.kind === "weekly-kits");

type Spec = {
  grade: "R" | "SR";
  level: number;
  exp: number;
  stock: Triple;
  basis?: Triple;
  /** Integer prior numerators for cohorts 0..3; cohort 3 positive. Absent = default 1:2:3:1. */
  priors?: readonly [number, number, number, number];
  /** Absent = the minimal v3 schedule: only the mandatory weekly grants. */
  events?: CertifiedInput["snapshot"]["events"];
  computeWaiting?: false;
  /** Historical v2 contract: the v3-only weekly rule field and weekly events removed.
   * The engine's 14-day recommendation horizon applies to every version. */
  contract?: "certified-daily-v2";
};
function input(spec: Spec): CertifiedInput {
  const built = structuredClone(baseSnapshot);
  built.events = structuredClone([...(spec.events ?? weeklyEvents)]);
  const snapshot: CertifiedInput["snapshot"] =
    spec.contract === "certified-daily-v2"
      ? {
          ...built,
          version: "certified-daily-v2",
          rules: built.rules.map(({ weeklyFixed: _weeklyFixed, ...rule }) => rule),
          events: built.events.filter((event) => event.kind !== "weekly-kits"),
        }
      : built;
  const receivedEventIds = snapshot.events
    .filter((event) => isCertifiedEventClaimable(snapshot, event, AS_OF))
    .map((event) => event.id);
  const priors = spec.priors;
  const total = priors ? priors[0] + priors[1] + priors[2] + priors[3] : 0;
  return {
    grade: spec.grade,
    level: spec.level,
    exp: spec.exp,
    stock: spec.stock,
    asOf: AS_OF,
    snapshot,
    receivedEventIds,
    ...(spec.computeWaiting === false ? { computeWaiting: false } : {}),
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

/** Weekly-only v3 schedule: deterministic (10,10,0) grants on days 7 and 14. */
const WEEKLY_ONLY = weeklyEvents;
/** Full built v3 schedule: weekly grants plus daily dispatch, shop and solo events. */
const FULL = baseSnapshot.events;
// Expected waiting days. 0: the current optimum is already unrestricted (SR15 is
// terminal; SR14 exp2900 completes with certainty on one blue use from stock).
// 14: later supply strictly improves the lexicographic value, so the earliest
// best day is the H14 boundary, certified by an independent cohort-0 witness.

// Exact multi-kit ties: a WASM-only scan of ~1000 real-game states/stocks (all
// grades/levels, exp sampled, six stock vectors) found no mask with two or more
// kits, because recurring rates make the three prices pairwise different. The
// tie contract is therefore exercised by exact mask equality on every case and
// by the STOP/no-kit (mask 0) fixtures below.
const FIXTURES: readonly (readonly [string, Spec, { mask?: number; waitingDays: 0 | 14 }])[] = [
  [
    "SR14 boundary, blue only, full schedule",
    { grade: "SR", level: 14, exp: 0, stock: [20, 0, 0], events: FULL },
    { mask: 1, waitingDays: 14 },
  ],
  [
    "SR15 terminal complete (mask 0)",
    { grade: "SR", level: 15, exp: 0, stock: [0, 0, 0] },
    { mask: 0, waitingDays: 0 },
  ],
  [
    "R0 zero stock preserve (mask 0), weekly grants plus a day-14 dispatch",
    {
      grade: "R",
      level: 0,
      exp: 0,
      stock: [0, 0, 0],
      events: [...WEEKLY_ONLY, ...dispatchArrival(14)],
    },
    { mask: 0, waitingDays: 14 },
  ],
  [
    "SR4 unusable yellow-only STOP (mask 0)",
    { grade: "SR", level: 4, exp: 0, stock: [0, 0, 10] },
    { mask: 0, waitingDays: 14 },
  ],
  [
    "R14 exp900 promotion boundary",
    { grade: "R", level: 14, exp: 900, stock: [10, 10, 10] },
    { mask: 1, waitingDays: 14 },
  ],
  [
    "SR14 exp2900 remainder-9 stock",
    { grade: "SR", level: 14, exp: 2900, stock: [19, 19, 19] },
    { mask: 1, waitingDays: 0 },
  ],
  [
    "R15 equals SR5",
    { grade: "R", level: 15, exp: 0, stock: [30, 30, 30] },
    { mask: 4, waitingDays: 14 },
  ],
  [
    "H14 cohort-0 witness, weekly grants plus a day-14 dispatch, empty stock",
    {
      grade: "SR",
      level: 14,
      exp: 0,
      stock: [0, 0, 0],
      events: [...WEEKLY_ONLY, ...dispatchArrival(14)],
    },
    { waitingDays: 14 },
  ],
  [
    "H14 cohort-0 witness, weekly grants only, one blue use",
    { grade: "SR", level: 14, exp: 0, stock: [10, 0, 0] },
    { waitingDays: 14 },
  ],
  [
    "historical v2 contract: H14 cohort-0 witness, one day-14 dispatch, empty stock",
    {
      grade: "SR",
      level: 14,
      exp: 0,
      stock: [0, 0, 0],
      events: dispatchArrival(14),
      contract: "certified-daily-v2",
    },
    { waitingDays: 14 },
  ],
  [
    "historical v2 contract: SR14 boundary, blue only, full schedule without weekly grants",
    {
      grade: "SR",
      level: 14,
      exp: 0,
      stock: [20, 0, 0],
      events: FULL,
      contract: "certified-daily-v2",
    },
    { mask: 1, waitingDays: 14 },
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
    expect(output.waiting.horizonDays).toBe(14);
    expect(output.waiting.recommendedDays).toBe(expected.waitingDays);
    if (expected.waitingDays === 14) {
      expect(output.waiting.strictBoundaryWitness?.cohort).toBe(0);
      expect(report.waiting.reason).toBe(
        "independent_exact_finite_endpoints_and_strict_lex_improvement",
      );
    } else {
      expect(report.waiting.reason).toBe("independently_exact_current_equals_unrestricted_optimum");
    }
  });

  it("checks cohort-3-only priors exactly and keeps the cohort-3 witness explicitly NOTRUN", () => {
    const { output, report } = check({
      grade: "SR",
      level: 14,
      exp: 0,
      stock: [0, 0, 0],
      priors: [0, 0, 0, 1],
    });
    expect(output.current?.optimalActionMask).toBe(0);
    expect(report).toMatchObject({
      status: "NOTRUN",
      pricing: { status: "PASS" },
      current: { status: "PASS" },
      batch: { status: "PASS" },
    });
    expect(output.waiting.recommendedDays).toBe(14);
    expect(output.waiting.strictBoundaryWitness?.cohort).toBe(3);
    expect(report.waiting).toEqual({
      status: "NOTRUN",
      reason: "independent_refresh_cohort_PMF_not_implemented",
    });
  });

  it("classifies an interior waiting day as NOTRUN while still comparing current exactly", () => {
    // The day-7 weekly grant carries 10 blue pieces: one blue use completes SR14
    // exp2900 with certainty, so the earliest best day is interior (7 < 14).
    const { output, report } = check({
      grade: "SR",
      level: 14,
      exp: 2900,
      stock: [0, 0, 0],
    });
    expect(output.status).toBe("completed");
    expect(output.waiting.recommendedDays).toBe(7);
    expect(report).toMatchObject({
      status: "NOTRUN",
      current: { status: "PASS" },
      waiting: {
        status: "NOTRUN",
        reason: "independent_full_expectation_for_interior_day_not_computed",
      },
    });
  });

  // v3 always has future weekly arrivals, so the former cheap day-0/no-arrival
  // waiting path no longer exists; every waiting result now needs an endpoint
  // certificate. Current/pricing/ties/batch keep the full 25-run property, and
  // waiting certificates get their own generated property.
  it(
    "matches exact pricing, current, ties and batch on generated in-domain inputs",
    async () => {
      await assertProperty(
        fc.property(specArbitrary, (spec) => {
          const { report } = check({ ...spec, computeWaiting: false });
          if (report.status === "FAIL") throw new Error(`lane_FAIL ${JSON.stringify(report)}`);
          return true;
        }),
        { name: "P1.lane", numRuns: NUM_RUNS, timeLimitMs: TIME_LIMIT_MS, identity: IDENTITY },
      );
    },
    HARD_DEADLINE_MS,
  );

  it(
    "never FAILs the waiting certificates on generated in-domain inputs",
    async () => {
      await assertProperty(
        fc.property(specArbitrary, (spec) => {
          const { report } = check(spec);
          if (report.status === "FAIL") throw new Error(`lane_FAIL ${JSON.stringify(report)}`);
          return true;
        }),
        {
          name: "P1.waiting",
          numRuns: WAITING_RUNS,
          timeLimitMs: TIME_LIMIT_MS,
          identity: IDENTITY,
        },
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
    // Waiting certificates were exercised for real, not only skipped.
    expect(
      tally.waiting["PASS:independent_exact_finite_endpoints_and_strict_lex_improvement"] ?? 0,
    ).toBeGreaterThanOrEqual(10);
  });
});
