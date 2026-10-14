import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { CertifiedSupplySnapshot } from "../shared/certifiedSupply.ts";
import type {
  CertifiedCurrent,
  CertifiedInput,
  CertifiedOutput,
  CertifiedValue,
  CertifiedWaiting,
} from "../src/certified/types.ts";
import { readV6Evidence } from "./certified-staging-approved-panel/v6/evidence.ts";
import {
  type ApprovedPanelRow,
  frozenApprovedSnapshot,
} from "./certified-staging-approved-panel.ts";
import {
  approx,
  cmp,
  type ExactQ,
  fromWire,
  type QTriple,
  q,
  type Triple,
  wire,
} from "./certified-staging-oracle.ts";
import {
  cachedOriginalOracle,
  prepareIndependentPhysicalRatesCache,
} from "./certified-staging-oracle-cache.ts";
import { independentCurrentCoverage } from "./certified-staging-oracle-current-coverage.ts";
import { solveIntegerOracle } from "./certified-staging-oracle-integer.ts";
import {
  independentCurrent,
  verifyBatch,
  verifyCertifiedLane,
  verifyCurrent,
  verifyPublicPricing,
  verifyWaitingLane,
} from "./certified-staging-oracle-lane.ts";
import { independentLargeIntegerOracle } from "./certified-staging-oracle-large-integer.ts";
import { mapTriple } from "./certified-staging-oracle-tuples.ts";

// Static closure of the lane (lane, approved-panel, v6 evidence/history, fixtures,
// oracle, certificates, current-coverage, cache, integer, large-*, layered,
// public-caps, witness, endpoints-integer, tuples; shared certifiedSupply*,
// certifiedRational, certifiedDispatchExpectations, soloRaidCadence,
// supplyForecastModel, game) imports node:fs (sync API), node:crypto and node:path
// only; no node:fs/promises, network module or worker. Its file calls are
// readFileSync/existsSync plus cache.ts mkdirSync/writeFileSync, which only the
// cache.ts exports below reach. fetch is stubbed before any module initialises.
// This covers the mocked channels only; it is not a universal no-I/O proof.
const network = vi.hoisted(() => {
  const refuse = vi.fn(() => {
    throw new Error("certified_lane_network_refused");
  });
  vi.stubGlobal("fetch", refuse);
  return refuse;
});
// Pass-through so tests can inject one unexpected oracle defect.
vi.mock("./certified-staging-oracle-large-integer.ts", async (importOriginal) => {
  type Module = typeof import("./certified-staging-oracle-large-integer.ts");
  const actual = await importOriginal<Module>();
  return { ...actual, independentLargeIntegerOracle: vi.fn(actual.independentLargeIntegerOracle) };
});
// Cache entry points refuse before any hit read or miss write; module-load source
// hashing of tracked files stays real.
vi.mock("./certified-staging-oracle-cache.ts", async (importOriginal) => {
  type Module = typeof import("./certified-staging-oracle-cache.ts");
  const actual = await importOriginal<Module>();
  const refuse = (name: string) =>
    vi.fn(() => {
      throw new Error(`certified_lane_cache_refused:${name}`);
    });
  return {
    ...actual,
    cachedOriginalOracle: refuse("cachedOriginalOracle"),
    prepareIndependentPhysicalRatesCache: refuse("prepareIndependentPhysicalRatesCache"),
  };
});
// The lane must never create caches, reports or directories, nor read untracked caches.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const observed = {
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
  const blocked = Object.fromEntries(
    [
      "appendFile",
      "appendFileSync",
      "copyFile",
      "copyFileSync",
      "cpSync",
      "mkdir",
      "mkdirSync",
      "mkdtempSync",
      "rename",
      "renameSync",
      "rm",
      "rmSync",
      "rmdirSync",
      "unlink",
      "unlinkSync",
      "writeFile",
      "writeFileSync",
    ].map((name) => [
      name,
      () => {
        throw new Error(`certified_lane_write_refused:${name}`);
      },
    ]),
  );
  return {
    ...actual,
    ...observed,
    ...blocked,
    default: { ...actual, ...observed, ...blocked },
  };
});
// Gitignored or untracked trees the lane must not read.
const EXCLUDED = /(^|\/)(benchmarks\/results|\.certified-test-tmp|\.mixdog|\.tmp|draft-)/;
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  expect(vi.mocked(cachedOriginalOracle)).not.toHaveBeenCalled();
  expect(vi.mocked(prepareIndependentPhysicalRatesCache)).not.toHaveBeenCalled();
  for (const spy of [vi.mocked(readFileSync), vi.mocked(existsSync)]) {
    const paths = spy.mock.calls.map(([path]) => String(path).replace(/\\/g, "/"));
    expect(paths.filter((path) => EXCLUDED.test(path))).toEqual([]);
    spy.mockClear();
  }
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const snapshot = frozenApprovedSnapshot();
const panel = readV6Evidence().panel as ApprovedPanelRow[];
const ZERO3: QTriple = [q(0), q(0), q(0)];
const TENTH: QTriple = [q(1, 10), q(1, 10), q(1, 10)];
const NOT_REQUESTED: CertifiedWaiting = {
  status: "not_requested",
  horizonDays: 56,
  recommendedDays: null,
  rangeBoundary: false,
  bestDayRange: null,
  value: null,
  evaluatedDays: [],
  successImprovementUpperBound: null,
  successProbabilityInterval: null,
  reason: null,
  evidence: [],
};

function row(index: number): ApprovedPanelRow {
  const value = panel[index];
  assert(value, `approved panel row ${index}`);
  return value;
}
function rowInput(entry: ApprovedPanelRow, patch: Partial<CertifiedInput> = {}): CertifiedInput {
  return { ...entry.input, snapshot, ...patch };
}
function rowPricing(entry: ApprovedPanelRow): NonNullable<CertifiedOutput["pricing"]> {
  return {
    basisStock: entry.input.stock,
    recurringRate: entry.expected.rates,
    weights: entry.expected.prices,
    cohortWeights: entry.expected.cohortWeights,
  };
}
function certifiedValue(P: ExactQ, B: ExactQ, C: ExactQ, consumed: QTriple): CertifiedValue {
  return {
    successP: wire(P),
    weightedExpectedConsumptionB: wire(B),
    expectedTotalConsumptionC: wire(C),
    expectedConsumed: mapTriple(consumed, wire),
    display: {
      successP: approx(P),
      weightedExpectedConsumptionB: approx(B),
      expectedTotalConsumptionC: approx(C),
    },
  };
}
// Contract mapping from src/certified/types.ts, not from candidate output.
function statusOf(
  input: Pick<CertifiedInput, "grade" | "level">,
  kit: CertifiedCurrent["kit"],
): CertifiedCurrent["status"] {
  if (input.grade === "SR" && input.level === 15) return "complete";
  return kit ? "use_certified" : "preserve";
}
function current(
  value: CertifiedValue,
  mask: number,
  kit: CertifiedCurrent["kit"],
  status: CertifiedCurrent["status"],
  uses = 0,
): CertifiedCurrent {
  return {
    status,
    value,
    kit,
    optimalActionMask: mask,
    uses,
    pieces: uses * 10,
    certification: "exact_rational_finite_inventory_v1",
  };
}
function output(patch: Partial<CertifiedOutput>): CertifiedOutput {
  return {
    status: "completed",
    current: null,
    waiting: NOT_REQUESTED,
    refusal: null,
    claimNotice: null,
    pricing: null,
    provenance: {
      solverVersion: "certified-exact-js-v1",
      arithmetic: "exact_bigint_ladder_reduced_public_rationals",
      calculationGraph: "repeated_exact_date_expectations_shared_finite_memo",
      requestBudgetMs: 15000,
      horizonMeaning: "range_only_no_deadline",
      snapshotRevision: "lane-test",
      snapshotSourceHash: "lane-test",
      objective: "max_P_min_B_min_C_exact_earliest_date",
    },
    diagnostics: {
      elapsedMs: 0,
      memoEntries: 0,
      exactTransitions: 0,
      supportPeakPoints: 0,
      managedPayloadBytes: 0,
      managedPayloadDefinition: "lane-test",
      unmeasuredMemory: [],
      wasmMemoryBytes: 0,
      kernelCalls: 0,
    },
    ...patch,
  };
}
const fail = (reason: string) => ({ status: "FAIL", reason });
const bump = (value: { numerator: string; denominator: string }) => ({
  ...value,
  numerator: String(BigInt(value.numerator) + 1n),
});

it("prices approved rows from public rules and authenticated cohorts, across exact representations", () => {
  for (const index of [0, 1, 2, 3, 4]) {
    const entry = row(index);
    const result = verifyPublicPricing(rowInput(entry), output({ pricing: rowPricing(entry) }));
    expect(result.check.status, entry.id).toBe("PASS");
    assert(result.prices);
    expect(
      mapTriple(result.prices, (price, color) =>
        cmp(price, fromWire(entry.expected.prices[color])),
      ),
    ).toEqual([0, 0, 0]);
  }
  const entry = row(0);
  const doubled = mapTriple(entry.expected.rates, (rate) => ({
    numerator: String(BigInt(rate.numerator) * 2n),
    denominator: String(BigInt(rate.denominator) * 2n),
  }));
  expect(
    verifyPublicPricing(
      rowInput(entry),
      output({ pricing: { ...rowPricing(entry), recurringRate: doubled } }),
    ).check.status,
  ).toBe("PASS");
  const drifted = mapTriple(entry.expected.rates, (rate, color) => (color ? rate : bump(rate)));
  expect(
    verifyPublicPricing(
      rowInput(entry),
      output({ pricing: { ...rowPricing(entry), recurringRate: drifted } }),
    ).check,
  ).toEqual({ status: "FAIL", reason: "pricing_recurring_rate_mismatch" });
});

it("uses default one-third priors and non-default priors with the declared price basis", () => {
  const basis: Triple = [1000, 0, 7];
  const base = row(1);
  const { cohortWeights: _priors, ...withoutPriors } = base.input;
  const third = q(1, 3);
  const cases: { input: CertifiedInput; rates: QTriple; priors: QTriple }[] = [
    {
      input: { ...withoutPriors, snapshot, priceBasisStock: basis },
      // Independently published default-prior physical rate.
      rates: mapTriple(readV6Evidence().physical.rate, fromWire),
      priors: [third, third, third],
    },
    {
      input: rowInput(row(0), { priceBasisStock: basis }),
      rates: mapTriple(row(0).expected.rates, fromWire),
      priors: mapTriple(row(0).expected.cohortWeights, fromWire),
    },
  ];
  for (const { input, rates, priors } of cases) {
    const weightsAt = (stock: Triple) =>
      mapTriple(rates, (rate, color) => wire(q(rate.d, BigInt(stock[color]) * rate.d + rate.n)));
    const pricing = {
      basisStock: basis,
      recurringRate: mapTriple(rates, wire),
      weights: weightsAt(basis),
      cohortWeights: mapTriple(priors, wire),
    };
    expect(verifyPublicPricing(input, output({ pricing })).check.status).toBe("PASS");
    expect(
      verifyPublicPricing(input, output({ pricing: { ...pricing, basisStock: input.stock } })).check
        .reason,
    ).toBe("pricing_basis_stock_mismatch");
    expect(
      verifyPublicPricing(
        input,
        output({ pricing: { ...pricing, weights: weightsAt(input.stock) } }),
      ).check.reason,
    ).toBe("pricing_weight_mismatch");
  }
});

it("reports unsupported pricing shapes as NOTRUN and missing API pricing by phase", () => {
  const entry = row(0);
  const pricing = rowPricing(entry);
  const solo: CertifiedSupplySnapshot = {
    ...snapshot,
    rules: snapshot.rules.map((rule) => ({
      ...rule,
      soloDays: [...rule.soloDays, [{ lawId: "deterministic:10,0,0", count: 1 }]],
    })),
  };
  expect(
    verifyPublicPricing(rowInput(entry, { snapshot: solo }), output({ pricing })).check,
  ).toEqual({ status: "NOTRUN", reason: "independent_pricing_solo_law_not_supported" });
  const cadence: CertifiedSupplySnapshot = {
    ...snapshot,
    cadence: { ...snapshot.cadence, numerator: snapshot.cadence.numerator + 1 },
  };
  expect(
    verifyPublicPricing(rowInput(entry, { snapshot: cadence }), output({ pricing })).check,
  ).toEqual({ status: "NOTRUN", reason: "independent_pricing_rule_or_prior_shape_not_supported" });
  const zero = certifiedValue(q(0), q(0), q(0), ZERO3);
  expect(
    verifyPublicPricing(rowInput(entry), output({ current: current(zero, 0, null, "preserve") }))
      .check,
  ).toEqual({ status: "FAIL", reason: "API_pricing_missing_while_current_present" });
  expect(verifyPublicPricing(rowInput(entry), output({ status: "refused" })).check).toEqual({
    status: "NOTRUN",
    reason: "API_pricing_absent:refused",
  });
});

// The approved rule starts exactly at the 2026-09-30 game-day start
// (05:00 KST = 2026-09-29T20:00Z); asOf 2026-09-30T08:00Z lies in that game day.
const DAY_START = "2026-09-29T20:00:00.000Z";
const AFTER_START = "2026-09-29T20:00:00.001Z";
function withRule(patch: Partial<CertifiedSupplySnapshot["rules"][number]>) {
  return { ...snapshot, rules: snapshot.rules.map((rule) => ({ ...rule, ...patch })) };
}

it("prices only when the single approved rule is active on the asOf game day", () => {
  const entry = row(0);
  const pricing = rowPricing(entry);
  const check = (supply: CertifiedSupplySnapshot, asOf = supply.asOf) =>
    verifyPublicPricing(rowInput(entry, { snapshot: supply, asOf }), output({ pricing })).check;
  const [rule] = snapshot.rules;
  assert(rule);
  expect([rule.effectiveFrom, rule.effectiveUntil, snapshot.asOf]).toEqual([
    DAY_START,
    null,
    "2026-09-30T08:00:00.000Z",
  ]);
  expect(snapshot.coverage.currentDay).toBe("2026-09-30");
  const inactive = {
    status: "NOTRUN",
    reason: "independent_pricing_rule_inactive_on_current_game_day",
  };
  // Inclusive start and exclusive end at the current game-day start.
  expect(check(snapshot).status).toBe("PASS");
  expect(check(withRule({ effectiveFrom: AFTER_START }))).toEqual(inactive);
  expect(check(withRule({ effectiveUntil: DAY_START }))).toEqual(inactive);
  expect(check(withRule({ effectiveUntil: AFTER_START })).status).toBe("PASS");
  // Same approved shape queried one game day before it takes effect.
  const before: CertifiedSupplySnapshot = {
    ...snapshot,
    events: [],
    asOf: "2026-09-29T08:00:00.000Z",
    coverage: { ...snapshot.coverage, currentDay: "2026-09-29" },
  };
  expect(check(before)).toEqual(inactive);
  // A later currentDay but the same rule ending at the 2026-10-01 game-day start.
  const expired: CertifiedSupplySnapshot = {
    ...withRule({ effectiveUntil: "2026-09-30T20:00:00.000Z" }),
    events: [],
    asOf: "2026-10-01T08:00:00.000Z",
    coverage: { ...snapshot.coverage, currentDay: "2026-10-01" },
  };
  expect(check(expired)).toEqual(inactive);
  expect(check(snapshot, "2026-09-30T09:00:00.000Z")).toEqual({
    status: "NOTRUN",
    reason: "input_asOf_differs_from_snapshot_asOf",
  });
  // Equal instants in another exact ISO representation are the same asOf.
  expect(check(snapshot, "2026-09-30T17:00:00.000+09:00").status).toBe("PASS");
  expect(
    check({ ...snapshot, coverage: { ...snapshot.coverage, currentDay: "2026-10-01" } }),
  ).toEqual({ status: "NOTRUN", reason: "snapshot_current_day_not_asOf_game_day" });
  const past = { ...rule, id: "past", effectiveFrom: "2026-09-01T20:00:00.000Z" };
  expect(check({ ...snapshot, rules: [{ ...past, effectiveUntil: DAY_START }, rule] })).toEqual({
    status: "NOTRUN",
    reason: "independent_pricing_rule_count_not_supported",
  });
});

it("never passes the terminal no-waiting gate outside the active-rule domain", () => {
  const entry = row(0);
  const expired: CertifiedSupplySnapshot = {
    ...snapshot,
    events: [],
    asOf: "2026-09-29T08:00:00.000Z",
    coverage: { ...snapshot.coverage, currentDay: "2026-09-29" },
  };
  const report = verifyCertifiedLane(
    rowInput(entry, {
      snapshot: expired,
      asOf: expired.asOf,
      grade: "SR",
      level: 15,
      exp: 0,
      computeWaiting: false,
    }),
    output({
      pricing: rowPricing(entry),
      current: current(certifiedValue(q(1), q(0), q(0), ZERO3), 0, null, "complete"),
    }),
  );
  expect(report.status).toBe("NOTRUN");
  expect(report.pricing.reason).toBe("independent_pricing_rule_inactive_on_current_game_day");
  expect(report.current.reason).toBe("current_requires_independent_pricing_PASS");
});

type SupplyLaw = CertifiedSupplySnapshot["laws"][number];
type LawRef = CertifiedSupplySnapshot["rules"][number]["dispatch"][number];
const FINITE_ROWS = [{ pieces: [10, 0, 0] as Triple, mass: wire(q(1)) }];
const finiteLaw = (id: string): SupplyLaw => ({
  id,
  kind: "finite",
  modelVersion: "lane-test-finite",
  ...(id === "dispatch-board-v1"
    ? { outcomesByCohort: [FINITE_ROWS, FINITE_ROWS, FINITE_ROWS] }
    : { outcomes: FINITE_ROWS }),
});
// Law ids are unique (snapshot validation), so an override replaces the built-in entry.
function withLaws(
  laws: readonly SupplyLaw[],
  soloDay?: readonly LawRef[],
): CertifiedSupplySnapshot {
  const ids = new Set(laws.map((law) => law.id));
  return {
    ...snapshot,
    laws: [...snapshot.laws.filter((law) => !ids.has(law.id)), ...laws],
    rules: snapshot.rules.map((rule) =>
      soloDay ? { ...rule, soloDays: [...rule.soloDays, soloDay] } : rule,
    ),
  };
}

it("keeps explicit finite overrides of used laws NOTRUN and unused finite laws exact", () => {
  const entry = row(0);
  const pricing = rowPricing(entry);
  const check = (supply: CertifiedSupplySnapshot) =>
    verifyPublicPricing(rowInput(entry, { snapshot: supply }), output({ pricing })).check;
  const override = { status: "NOTRUN", reason: "independent_law_not_supported:finite_override" };
  // The product honours explicit finite laws for built-in ids, including the
  // per-cohort dispatch law (shared/certifiedSupplyLaws.ts findFiniteLaw).
  for (const id of ["dispatch-board-v1", "regular-box-v1", "box-ii-v1"])
    expect(check(withLaws([finiteLaw(id)])), id).toEqual(override);
  const used = (id: string, count: number) => withLaws([finiteLaw(id)], [{ lawId: id, count }]);
  expect(check(used("deterministic:10,0,0", 1))).toEqual(override);
  // A finite law that no active dispatch/normal-shop/solo ref uses with a positive
  // count adds zero (getCertifiedLawExpectedGain), so the approved prices still hold.
  const custom = "lane-custom-finite-v1";
  const baseline = check(snapshot);
  expect(baseline.status).toBe("PASS");
  expect(check(withLaws([finiteLaw(custom)]))).toEqual(baseline);
  expect(check(used(custom, 0))).toEqual(baseline);
  expect(check(used(custom, 1))).toEqual(override);
});

it("fails malformed pricing triples, malformed current vectors and invalid batch uses", () => {
  const entry = row(0);
  const pricing = rowPricing(entry);
  const pricingCheck = (patch: Record<string, unknown>) =>
    verifyPublicPricing(rowInput(entry), output({ pricing: { ...pricing, ...patch } as never }))
      .check;
  const rest = pricing.cohortWeights.slice(1);
  const cases: [string, Record<string, unknown>][] = [
    ["basisStock", { basisStock: [] }],
    ["basisStock", { basisStock: new Array(3) }],
    ["basisStock", { basisStock: pricing.basisStock.slice(0, 2) }],
    ["basisStock", { basisStock: [...pricing.basisStock, 0] }],
    ["basisStock", { basisStock: [0.5, 0, 0] }],
    ["recurringRate", { recurringRate: [] }],
    ["recurringRate", { recurringRate: pricing.recurringRate.slice(0, 2) }],
    ["weights", { weights: [...pricing.weights, pricing.weights[0]] }],
    ["cohortWeights", { cohortWeights: [{ numerator: 1, denominator: "3" }, ...rest] }],
    ["cohortWeights", { cohortWeights: [{ numerator: "1", denominator: "0" }, ...rest] }],
  ];
  const malformed = (field: string) => ({ status: "FAIL", reason: `pricing_malformed:${field}` });
  for (const [field, patch] of cases) expect(pricingCheck(patch), field).toEqual(malformed(field));
  const prices = mapTriple(entry.expected.prices, fromWire);
  const base = recordedCurrent(entry);
  const short = {
    ...base,
    value: { ...base.value, expectedConsumed: base.value.expectedConsumed.slice(0, 2) },
  } as never;
  expect(verifyCurrent(rowInput(entry), output({ current: short }), prices).check).toEqual(
    fail("current_exact_PBC_or_consumed_vector_mismatch"),
  );

  const expected = independentCurrent({ ...SR14, prices: TENTH }).result;
  assert(expected);
  const zero = certifiedValue(q(0), q(0), q(0), ZERO3);
  const batch = (uses: number) =>
    verifyBatch(SR14, current(zero, 0, null, "preserve", uses), TENTH, expected);
  for (const uses of [-1, 2.5, Number.NaN])
    expect(batch(uses), String(uses)).toEqual(fail("batch_uses_not_nonnegative_integer"));
  // A valid shorter batch remains a possible CertifiedLimit cut.
  expect(batch(4).status).toBe("NOTRUN");
});

it("propagates an authenticated-evidence identity failure instead of NOTRUN", async () => {
  const entry = row(0);
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  const tampered = ((path: Parameters<typeof readFileSync>[0], options?: unknown) =>
    String(path).replace(/\\/g, "/").endsWith("/v6/pins.json")
      ? JSON.stringify({ version: "tampered" })
      : real.readFileSync(path, options as never)) as typeof readFileSync;
  vi.mocked(readFileSync).mockImplementation(tampered);
  try {
    expect(() =>
      verifyPublicPricing(rowInput(entry), output({ pricing: rowPricing(entry) })),
    ).toThrow("Independent physical pin identity drift");
  } finally {
    vi.mocked(readFileSync).mockImplementation(real.readFileSync);
  }
});

function recordedCurrent(entry: ApprovedPanelRow, uses = 0): CertifiedCurrent {
  const expected = entry.expected;
  return current(
    certifiedValue(
      fromWire(expected.successP),
      fromWire(expected.weightedExpectedConsumptionB),
      fromWire(expected.expectedTotalConsumptionC),
      mapTriple(expected.expectedConsumed, fromWire),
    ),
    expected.mask,
    expected.action,
    statusOf(entry.input, expected.action),
    uses,
  );
}

it("cross-validates every recorded approved current optimum with the write-free in-memory oracle", () => {
  for (const entry of panel) {
    const prices = mapTriple(entry.expected.prices, fromWire);
    const candidate = output({ current: recordedCurrent(entry) });
    expect(verifyCurrent(rowInput(entry), candidate, prices).check.status, entry.id).toBe("PASS");
  }
});

it("rejects one-unit value drift, a changed mask bit, a changed kit and inconsistent pieces", () => {
  const entry = panel.find((candidate) => candidate.expected.action !== null);
  assert(entry, "approved row with an optimal kit");
  const prices = mapTriple(entry.expected.prices, fromWire);
  const base = recordedCurrent(entry);
  const reason = (patch: Partial<CertifiedCurrent>) =>
    verifyCurrent(rowInput(entry), output({ current: { ...base, ...patch } }), prices).check.reason;
  expect(reason({})).toMatch(/^current_exact:/);
  expect(
    reason({
      value: {
        ...base.value,
        weightedExpectedConsumptionB: bump(base.value.weightedExpectedConsumptionB),
      },
    }),
  ).toBe("current_exact_PBC_or_consumed_vector_mismatch");
  expect(
    reason({
      value: {
        ...base.value,
        expectedConsumed: mapTriple(base.value.expectedConsumed, (value, color) =>
          color === 2 ? bump(value) : value,
        ),
      },
    }),
  ).toBe("current_exact_PBC_or_consumed_vector_mismatch");
  expect(reason({ optimalActionMask: base.optimalActionMask ^ 4 })).toBe(
    "current_optimal_action_mask_mismatch",
  );
  const otherKit = (["blue", "purple", "yellow"] as const).find((kit) => kit !== base.kit);
  assert(otherKit);
  expect(reason({ kit: otherKit })).toBe("current_kit_or_status_mismatch");
  expect(reason({ uses: 1, pieces: 20 })).toBe("current_batch_pieces_not_ten_per_use");
});

// SR14 blue great success is 10.0% (shared/game.ts); a failed blue use adds 200
// EXP, so five units stay below the 3000-EXP level boundary.
const SR14 = { grade: "SR", level: 14, exp: 0, stock: [50, 0, 0] } as const;
const SR14_P = q(40951, 100000);
const SR14_C = q(40951, 1000);

it("matches hand-derived exact SR14 blue values from public great-success odds", () => {
  const result = independentCurrent({ ...SR14, prices: TENTH }).result;
  assert(result);
  expect(result.P).toEqual(SR14_P);
  expect(result.C).toEqual(SR14_C);
  expect(result.B).toEqual(q(40951, 10000));
  expect(result.consumed).toEqual([SR14_C, q(0), q(0)]);
  expect(result.ties).toEqual(["blue"]);
});

it("keeps the default current-coverage caller on the established cache entry point", () => {
  const input = { ...SR14, prices: TENTH };
  const cache = vi.mocked(cachedOriginalOracle);
  expect(() => independentCurrentCoverage(input)).toThrow(
    "certified_lane_cache_refused:cachedOriginalOracle",
  );
  expect(cache.mock.calls).toEqual([[input]]);
  cache.mockClear();
  // The explicit write-free evaluator yields the hand-derived SR14 value.
  const explicit = independentCurrentCoverage(input, solveIntegerOracle);
  expect(explicit.basis).toBe("original_guard_le30_exact_uncapped_inventory_DP");
  expect(explicit.result?.P).toEqual(SR14_P);
  expect(cache).not.toHaveBeenCalled();
});

it("reports NOTRUN when every expanded oracle refuses admission above 150 uses", () => {
  // 160 blue units from R0 cannot finish SR15 in the unrestricted worst case, and
  // each <=150-use oracle refuses before evaluating.
  const input = { grade: "R", level: 0, exp: 0, stock: [1600, 0, 0], prices: TENTH } as const;
  expect(independentCurrent(input)).toEqual({
    basis: [
      "NOTRUN_expanded_stock_without_independent_feasible_unrestricted_or_recorded_finite_proof",
      "large_oracle_admission_max150_initial_uses",
      "independent_public_cap_admission_max150_initial_uses",
      "independent_layered_input_admission_invalid",
    ].join(";"),
  });
  const candidate = output({
    current: current(certifiedValue(q(0), q(0), q(0), ZERO3), 0, null, "preserve"),
  });
  expect(verifyCurrent(input, candidate, TENTH).check).toMatchObject({
    status: "NOTRUN",
    reason: expect.stringMatching(/^independent_current_not_computed:NOTRUN_expanded/),
  });
});

it("propagates an unexpected expanded-oracle error instead of NOTRUN", () => {
  const input = { grade: "R", level: 0, exp: 0, stock: [310, 0, 0], prices: TENTH } as const;
  const defect = new Error("unexpected_oracle_defect");
  const oracle = vi.mocked(independentLargeIntegerOracle);
  oracle.mockClear();
  oracle.mockImplementationOnce(() => {
    throw defect;
  });
  expect(() => independentCurrent(input)).toThrow(defect);
  expect(oracle).toHaveBeenCalledTimes(1);
  oracle.mockClear();
});

it("derives the batch as the contract normal-path prefix and never passes a short batch", () => {
  const cases: {
    name: string;
    input: Pick<CertifiedInput, "grade" | "level" | "exp" | "stock" | "batchLimit">;
    uses: number;
  }[] = [
    { name: "stock exhausted", input: SR14, uses: 5 },
    { name: "default limit", input: { ...SR14, stock: [150, 0, 0] }, uses: 10 },
    { name: "explicit limit", input: { ...SR14, stock: [150, 0, 0], batchLimit: 12 }, uses: 12 },
    { name: "limit one", input: { ...SR14, stock: [150, 0, 0], batchLimit: 1 }, uses: 1 },
    { name: "level change", input: { ...SR14, exp: 2000, stock: [100, 0, 0] }, uses: 5 },
    { name: "certain great success", input: { ...SR14, stock: [0, 0, 30] }, uses: 1 },
    { name: "all tied first kit", input: { ...SR14, exp: 2900, stock: [10, 10, 10] }, uses: 1 },
    { name: "below ten", input: { ...SR14, stock: [5, 0, 0] }, uses: 0 },
    { name: "terminal", input: { ...SR14, level: 15, stock: [100, 0, 0] }, uses: 0 },
  ];
  const zero = certifiedValue(q(0), q(0), q(0), ZERO3);
  for (const { name, input, uses } of cases) {
    const expected = independentCurrent({ ...input, prices: TENTH }).result;
    assert(expected, name);
    const batch = (count: number) =>
      verifyBatch(input, current(zero, 0, null, "preserve", count), TENTH, expected).status;
    expect(batch(uses), name).toBe("PASS");
    expect(batch(uses + 1), name).toBe("FAIL");
    if (uses > 0) expect(batch(uses - 1), name).toBe("NOTRUN");
  }
});

const quiet: CertifiedSupplySnapshot = { ...snapshot, events: [] };
const sr14Input = (supply: CertifiedSupplySnapshot): CertifiedInput => ({
  ...SR14,
  asOf: supply.asOf,
  snapshot: supply,
});
const sr14Value = certifiedValue(SR14_P, q(40951, 10000), SR14_C, [SR14_C, q(0), q(0)]);
const day0 = (patch: Partial<CertifiedWaiting> = {}): CertifiedWaiting => ({
  ...NOT_REQUESTED,
  status: "certified",
  recommendedDays: 0,
  bestDayRange: [0, 0],
  value: sr14Value,
  successProbabilityInterval: { lower: wire(SR14_P), upper: wire(SR14_P) },
  successImprovementUpperBound: wire(q(59049, 100000)),
  ...patch,
});

it("passes an exact day-0 answer without arrivals for a verified current P below one", () => {
  const verified = independentCurrent({ ...SR14, prices: TENTH }).result;
  assert(verified);
  const candidate = (waiting: CertifiedWaiting) =>
    output({ current: current(sr14Value, 1, "blue", "use_certified", 5), waiting });
  const check = (supply: CertifiedSupplySnapshot, waiting: CertifiedWaiting) =>
    verifyWaitingLane(sr14Input(supply), candidate(waiting), TENTH, verified);
  expect(check(quiet, day0())).toMatchObject({ status: "PASS" });
  expect(
    check(quiet, day0({ successProbabilityInterval: { lower: wire(q(1)), upper: wire(q(1)) } }))
      .reason,
  ).toBe("day0_probability_interval_or_gap_not_exact_current_P");
  expect(check(quiet, day0({ successImprovementUpperBound: wire(q(0)) })).status).toBe("FAIL");
  expect(
    check(
      quiet,
      day0({
        value: {
          ...sr14Value,
          weightedExpectedConsumptionB: bump(sr14Value.weightedExpectedConsumptionB),
        },
      }),
    ).reason,
  ).toBe("day0_value_differs_from_independently_verified_current");
  expect(check(quiet, day0({ bestDayRange: [0, 56] })).status).toBe("FAIL");
  expect(snapshot.events.some((event) => event.refs.some((ref) => ref.count > 0))).toBe(true);
  expect(check(snapshot, day0()).reason).toBe(
    "day0_with_snapshot_arrivals_tie_not_independently_proved",
  );
  const incomplete: CertifiedSupplySnapshot = {
    ...quiet,
    coverage: { ...quiet.coverage, future: { ...quiet.coverage.future, complete: false } },
  };
  expect(check(incomplete, day0()).status).toBe("NOTRUN");
  // Without a verified current, the existing N0 contract applies unchanged.
  expect(verifyWaitingLane(sr14Input(quiet), candidate(day0()), TENTH, undefined).reason).toBe(
    "N0_current_exact_parity_not_established",
  );
});

it("keeps a certain day-0 current above the unrestricted cost NOTRUN", () => {
  // SR14 yellow is a certain great success (shared/game.ts): one yellow use gives
  // P=1, B=10 at yellow price 1. Unrestricted blue reaches SR15 at expected cost
  // (1-0.9^15)/0.1 < 10, so the current is not the unrestricted optimum.
  const prices: QTriple = [q(1, 10), q(1, 10), q(1)];
  const input: CertifiedInput = { ...sr14Input(quiet), stock: [0, 0, 10] };
  const verified = independentCurrent({ ...input, prices }).result;
  assert(verified);
  expect([verified.P, verified.B, verified.C]).toEqual([q(1), q(10), q(10)]);
  const value = certifiedValue(q(1), q(10), q(10), [q(0), q(0), q(10)]);
  const waiting = day0({
    value,
    successProbabilityInterval: { lower: wire(q(1)), upper: wire(q(1)) },
    successImprovementUpperBound: wire(q(0)),
  });
  const candidate = output({ current: current(value, 4, "yellow", "use_certified", 1), waiting });
  expect(verifyWaitingLane(input, candidate, prices, verified)).toEqual({
    status: "NOTRUN",
    reason: "day0_P1_above_unrestricted_cost_not_independently_proved",
  });
});

const terminalValue = certifiedValue(q(1), q(0), q(0), ZERO3);
const terminalWaiting = day0({
  value: terminalValue,
  successProbabilityInterval: { lower: wire(q(1)), upper: wire(q(1)) },
  successImprovementUpperBound: wire(q(0)),
});

it("keeps the existing N0 route for a verified terminal unrestricted optimum", () => {
  const input: CertifiedInput = { ...sr14Input(snapshot), level: 15, stock: [0, 0, 0] };
  const verified = independentCurrent({ ...input, prices: TENTH }).result;
  assert(verified);
  const candidate = output({
    current: current(terminalValue, 0, null, "complete"),
    waiting: terminalWaiting,
  });
  expect(verifyWaitingLane(input, candidate, TENTH, verified).status).toBe("PASS");
});

it("delegates later days unchanged: interior and unresolved stay NOTRUN, cohort-0 H56 witness PASS", () => {
  const input = sr14Input(snapshot);
  const certified = (patch: Partial<CertifiedWaiting>) =>
    verifyWaitingLane(input, output({ waiting: day0(patch) }), TENTH, undefined).reason;
  expect(certified({ recommendedDays: 10, bestDayRange: [10, 10] })).toBe(
    "independent_full_expectation_for_interior_day_not_computed",
  );
  expect(certified({ status: "unresolved" })).toBe("API_waiting_not_certified:unresolved");

  const artifact = JSON.parse(
    readFileSync(
      "scripts/certified-staging-oracle-fixtures/historical-r0-witness.json.txt",
      "utf8",
    ),
  ) as { input: CertifiedInput; records: readonly { output: CertifiedOutput }[] };
  const historical: CertifiedInput = {
    ...artifact.input,
    snapshot: { ...artifact.input.snapshot, futureLawSemantics: "independent_given_cohort-v1" },
  };
  const record = artifact.records[0];
  assert(record);
  // Default-prior rate from authenticated tracked evidence; the rates cache is not read.
  const rates = mapTriple(readV6Evidence().physical.rate, fromWire);
  const prices = mapTriple(rates, (rate, color) =>
    q(rate.d, BigInt(historical.stock[color]) * rate.d + rate.n),
  );
  const witnessOutput = structuredClone(record.output);
  // Without a verified current the interval validity stays NOTRUN in the metadata.
  expect(verifyWaitingLane(historical, witnessOutput, prices, undefined)).toMatchObject({
    status: "PASS",
    receiptCount: 80,
    probabilityIntervalValidity: "NOTRUN",
  });
  const witness = witnessOutput.waiting.strictBoundaryWitness;
  assert(witness);
  witnessOutput.waiting.strictBoundaryWitness = { ...witness, cohort: 1 };
  expect(verifyWaitingLane(historical, witnessOutput, prices, undefined).status).toBe("NOTRUN");
});

it("gates PASS only on completed pricing, current, batch and requested certified waiting", () => {
  const entry = row(0);
  const input = rowInput(entry, { grade: "SR", level: 15, exp: 0, computeWaiting: false });
  const base = output({
    pricing: rowPricing(entry),
    current: current(terminalValue, 0, null, "complete"),
  });
  const gate = (candidate: CertifiedOutput, patch: Partial<CertifiedInput> = {}) =>
    verifyCertifiedLane({ ...input, ...patch }, candidate).status;
  expect(verifyCertifiedLane(input, base)).toMatchObject({
    status: "PASS",
    api: { status: "PASS" },
    pricing: { status: "PASS" },
    current: { status: "PASS" },
    batch: { status: "PASS" },
    waiting: { status: "PASS" },
  });
  const requested = { computeWaiting: true };
  const waited = verifyCertifiedLane(
    { ...input, ...requested },
    { ...base, waiting: terminalWaiting },
  );
  expect(waited.status).toBe("PASS");
  // The report keeps the certificate metadata instead of only status/reason.
  expect(waited.waiting).toEqual({
    status: "PASS",
    reason: "independently_exact_current_equals_unrestricted_optimum",
    probabilityIntervalValidity: "PASS",
  });
  // A failed current is not handed on as verified; N0 still establishes terminal
  // parity from feasibility alone, and the overall report stays FAIL.
  const wrongMask = current(terminalValue, 1, null, "complete");
  const unverified = verifyCertifiedLane(
    { ...input, ...requested },
    { ...base, current: wrongMask, waiting: terminalWaiting },
  );
  expect(unverified.current).toEqual(fail("current_optimal_action_mask_mismatch"));
  expect(unverified.waiting).toEqual(waited.waiting);
  expect(unverified.status).toBe("FAIL");
  expect(gate({ ...base, waiting: terminalWaiting })).toBe("FAIL");
  expect(gate(base, requested)).toBe("NOTRUN");
  expect(gate({ ...base, waiting: { ...NOT_REQUESTED, status: "unresolved" } }, requested)).toBe(
    "NOTRUN",
  );
  expect(
    gate({ ...base, waiting: { ...NOT_REQUESTED, status: "claim_required" } }, requested),
  ).toBe("NOTRUN");
  expect(gate({ ...base, status: "partial", waiting: terminalWaiting }, requested)).toBe("NOTRUN");
  const refused = verifyCertifiedLane(input, {
    ...base,
    refusal: { reason: "certified_resource_limit", phase: "waiting" },
  });
  expect(refused.status).toBe("NOTRUN");
  expect(refused.api).toEqual({
    status: "NOTRUN",
    reason: "API_completed_with_refusal:waiting:certified_resource_limit",
  });
  const drifted = {
    ...rowPricing(entry),
    weights: mapTriple(entry.expected.prices, (price, color) => (color ? price : bump(price))),
  };
  expect(gate({ ...base, status: "partial", pricing: drifted })).toBe("FAIL");
  expect(gate(output({ status: "refused" }))).toBe("NOTRUN");
});
