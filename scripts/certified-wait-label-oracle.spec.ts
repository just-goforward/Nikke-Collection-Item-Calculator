import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertProperty } from "../shared/propertyHarness.ts";
import {
  add,
  canonicalState,
  compareValue,
  createOracleEvaluator,
  independentFailure,
  independentSuccess,
  type QTriple,
  q,
  type Triple,
} from "./certified-staging-oracle.ts";
import { makeTriple, mapTriple } from "./certified-staging-oracle-tuples.ts";
import {
  independentBoxMass,
  independentDispatchZeroMass,
} from "./certified-staging-oracle-witness.ts";
import * as O from "./certified-wait-label-oracle.ts";

const SPEC = "scripts/certified-wait-label-oracle.spec.ts";
const ORACLE = "scripts/certified-wait-label-oracle.ts";
/** Shared fixed-seed runner (fast-check 4.10.2, interruptAfterTimeLimit with
 * failOnInterrupt); failures carry seed, path, version and source hashes. */
const property = (name: string, numRuns: number, timeLimitMs: number) => ({
  name,
  numRuns,
  timeLimitMs,
  identity: {
    file: SPEC,
    generatorSource: readFileSync(SPEC, "utf8"),
    sources: { [ORACLE]: readFileSync(ORACLE, "utf8") },
  },
});
function positiveBoxPoints(law: "regular-box-v1" | "box-ii-v1", count: number): Triple[] {
  const positive: Triple[] = [];
  for (let b = 0; b <= 5 * count; b++)
    for (let p = 0; p <= 2 * count; p++)
      for (let y = 0; y <= 2 * count; y++)
        if (independentBoxMass(law, count, [b, p, y]).n > 0n) positive.push([b, p, y]);
  return positive;
}

/** Pre-registered before any product comparison: sha256 of the committed bytes. */
const PINS: Record<string, string> = {
  "fixtures.json": "43dcdf764a2129b4087e8d42eacd7da2974fa66a6e7aa1b54ba9aa2ebbfbf37f",
  "expected/R0.json": "0fbae392d9222af45dbdc035b03648382aa072b09489dd1d55dcb016bf1aae84",
  "expected/R10.json": "400e0399255d9e4470be792f555a69f0022ba7f49e690a2ee2288666dd97eecb",
  "expected/R14.json": "5737ab4c5af2ac5a007faab4b6e94842c531f7801ae172d8a8472a878a788118",
  "expected/SR5.json": "d654768a0ba3b5cdd75597698326b825abc6c1d32094ea6ae8dd9b02160bd046",
  "expected/SR10.json": "08708b38cb43d0f311fd22d52fd3dd6817c042b636541fb640b9743435223c38",
  "expected/SR13.json": "ed3404ed3a4982d2449f8ce16427f88605d27e0cf4ed04d664d008fcf8d76326",
  "fixtures-tie.json": "fb09cfc419912a5e36ce16d21be15b44472771655809f175696845ce323d29bf",
  "expected/TIE-R5.json": "c6d015947923184ea4226b03630326c9a58bae4869eca2205192c49c68de8d43",
};
/** Human-readable copy of the pre-registered results (kit, uses, label, per-day P crossing
 * counts). In all six fixtures the informational P/B/C crossing sets equal the P sets. */
const SUMMARY: Record<string, readonly [string, number, number | "7+", readonly number[]]> = {
  R0: ["blue", 2, "7+", [0, 0, 0, 0, 0, 0, 0]],
  R10: ["blue", 2, "7+", [0, 0, 0, 0, 0, 0, 0]],
  R14: ["blue", 1, "7+", [0, 0, 0, 0, 0, 0, 0]],
  SR5: ["blue", 2, "7+", [0, 0, 0, 0, 0, 0, 0]],
  SR10: ["yellow", 1, 3, [0, 0, 5, 30, 61, 99, 267]],
  SR13: ["purple", 1, 3, [0, 0, 2, 5, 15, 31, 31]],
};
const fixtures = O.loadWaitLabelFixtures();
const expectedDocument = (id: string) =>
  JSON.parse(readFileSync(O.expectedFile(id), "utf8")) as {
    fixtureFileSha256: string;
    result: Extract<O.WaitLabelResult, { status: "EXACT" }>;
  };

describe("pre-registered wait-label fixtures", () => {
  it("pins fixture definitions and expectations by sha256", () => {
    for (const [path, sha] of Object.entries(PINS))
      expect([path, O.sha256(readFileSync(resolve(O.FIXTURE_DIRECTORY, path)))]).toEqual([
        path,
        sha,
      ]);
    for (const id of Object.keys(SUMMARY)) {
      const document = expectedDocument(id);
      expect(document.fixtureFileSha256).toBe(PINS["fixtures.json"]);
      const { recommendation, label, perDay } = document.result;
      expect([
        recommendation.kit,
        recommendation.uses,
        label,
        perDay.map((d) => d.crossingUnits.length),
      ]).toEqual(SUMMARY[id]);
      expect(perDay.map((d) => d.bCrossingUnits)).toEqual(perDay.map((d) => d.crossingUnits));
      expect(perDay.map((d) => d.supportUnitCount)).toEqual([9, 37, 92, 190, 335, 535, 1022]);
      expect(document.result.certificateConsistent).toBe(true);
    }
  });

  it.each(Object.keys(SUMMARY))(
    "recomputes %s exactly as pre-registered",
    (id) => {
      const fixture = fixtures.find((entry) => entry.id === id);
      if (!fixture) throw new Error(`missing fixture ${id}`);
      const actual = O.computeWaitLabel(fixture, { deadlineAt: performance.now() + 600_000 });
      expect(JSON.parse(JSON.stringify(actual))).toEqual(expectedDocument(id).result);
    },
    900_000,
  );

  it("reports an exhausted budget as NOTRUN/unknown instead of approximating", () => {
    const fixture = fixtures.find((entry) => entry.id === "SR13");
    if (!fixture) throw new Error("missing SR13");
    expect(O.computeWaitLabel(fixture, { maxNodes: 1 })).toEqual({
      status: "NOTRUN",
      id: "SR13",
      label: "unknown",
      reason: "wait_label_oracle_budget:nodes",
    });
  }, 120_000);
});

/** Supply rules v3 (certified-daily-v3): the same states with the public Wednesday
 * grant. Pre-registered by `record <id> 900000 fixtures-v3.json`. */
const V3_PINS: Record<string, string> = {
  "fixtures-v3.json": "24706763038f89fafeb52dc2f02b4650e9d0070023ff1bec54a9190ed2d9a818",
  "expected/V3-R0.json": "e5a47c45379ab6a172148c8eb830347ef7efb7f6afc042fd53513a287b3701bc",
  "expected/V3-R10.json": "58bbd61ef460e136f9cd073ef0cea985c21b3acb9631a15d3dee82ae7ab6ac06",
  "expected/V3-R14.json": "ee85a38fdbbd1c02448dfc26595bd32d0b1135fca41b44c20104d56691844249",
  "expected/V3-SR5.json": "a4856040fbb6c4a161902dc74671cbeb86f02b6f17e9a7cf53c361d3e3ff1a3e",
  "expected/V3-SR10.json": "727c9124f5a8d8e5f453be7694ef9710358d99d60d072251b128570169eee49a",
  "expected/V3-SR13.json": "dd0eaeaf0b23bfcf5dcc5bfae3bf2a34f377f99ed0f5d583ba9f3b8fabee74ee",
};
const V3_SUMMARY: Record<string, readonly [string, number, number | "7+", readonly number[]]> = {
  "V3-R0": ["blue", 2, "7+", [0, 0, 0, 0, 0, 0, 0]],
  "V3-R10": ["blue", 2, "7+", [0, 0, 0, 0, 0, 0, 0]],
  "V3-R14": ["blue", 1, "7+", [0, 0, 0, 0, 0, 0, 0]],
  "V3-SR5": ["blue", 2, "7+", [0, 0, 0, 0, 0, 0, 0]],
  "V3-SR10": ["yellow", 1, 2, [0, 3, 19, 40, 64, 122, 316]],
  "V3-SR13": ["purple", 1, 4, [0, 0, 0, 5, 16, 18, 18]],
};
const v3Fixtures = O.loadWaitLabelFixtures("fixtures-v3.json");

describe("pre-registered v3 wait-label fixtures", () => {
  it("derives the v3 fixtures from fixtures.json and the public weekly rule only", () => {
    type File = {
      common: { schedule: O.ScheduledEvent[]; pricing: O.PricingRules } & Record<string, unknown>;
      fixtures: Record<string, unknown>[];
    };
    const read = (name: string) =>
      JSON.parse(readFileSync(resolve(O.FIXTURE_DIRECTORY, name), "utf8")) as File;
    const v2 = read("fixtures.json");
    const v3 = read("fixtures-v3.json");
    const { schedule: s2, pricing: p2, ...rest2 } = v2.common;
    const { schedule: s3, pricing: p3, ...rest3 } = v3.common;
    expect(rest3).toEqual(rest2);
    // Schedule: exactly one added event, the Wednesday 2026-10-14 grant on day 1.
    expect(s3.filter((event) => !s2.some((old) => old.id === event.id))).toEqual([
      { id: "weekly-kits:2026-10-14", day: 1, refs: [{ lawId: O.WEEKLY_FIXED_LAW, count: 1 }] },
    ]);
    expect(s3.filter((event) => s2.some((old) => old.id === event.id))).toEqual(s2);
    expect(new Date("2026-10-14T00:00:00Z").getUTCDay()).toBe(3);
    // Pricing: same public terms plus the weekly grant, the v3 rule id and catalog.
    const { weeklyFixed, id, ...rule3 } = p3.rules[0] ?? {
      dispatch: [],
      normalShop: [],
      soloDays: [],
    };
    expect([p3.version, id, weeklyFixed]).toEqual([
      "certified-daily-v3",
      "schedule-kit-v3:documented-physical-supply-v2",
      [{ lawId: O.WEEKLY_FIXED_LAW, count: 1 }],
    ]);
    expect(rule3).toEqual(p2.rules[0]);
    expect(p3.cadence).toEqual(p2.cadence);
    const states = (file: File) =>
      file.fixtures.map(({ id, source: _source, ...state }) => ({
        id: String(id).replace(/^V3-/, ""),
        ...state,
      }));
    expect(states(v3)).toEqual(states(v2));
    // The weekly grant adds exactly (10, 10, 0) / 7 per day to the recurring rate.
    const [first] = fixtures;
    const [firstV3] = v3Fixtures;
    if (!first || !firstV3) throw new Error("missing fixtures");
    const delta = mapTriple(O.independentRates(firstV3), (rate, j) =>
      add(rate, q(-O.independentRates(first)[j].n, O.independentRates(first)[j].d)),
    );
    expect(delta).toEqual([q(10, 7), q(10, 7), q(0)]);
    expect(O.lawSupport({ lawId: O.WEEKLY_FIXED_LAW, count: 2 }, 3)).toEqual([[20, 20, 0]]);
  });

  it("pins v3 fixture definitions and expectations by sha256", () => {
    for (const [path, sha] of Object.entries(V3_PINS))
      expect([path, O.sha256(readFileSync(resolve(O.FIXTURE_DIRECTORY, path)))]).toEqual([
        path,
        sha,
      ]);
    for (const id of Object.keys(V3_SUMMARY)) {
      const document = expectedDocument(id);
      expect(document.fixtureFileSha256).toBe(V3_PINS["fixtures-v3.json"]);
      const { recommendation, label, perDay } = document.result;
      expect([
        recommendation.kit,
        recommendation.uses,
        label,
        perDay.map((d) => d.crossingUnits.length),
      ]).toEqual(V3_SUMMARY[id]);
      expect(perDay.map((d) => d.bCrossingUnits)).toEqual(perDay.map((d) => d.crossingUnits));
      expect(perDay.map((d) => d.supportUnitCount)).toEqual([9, 37, 92, 190, 335, 535, 1022]);
      expect(document.result.certificateConsistent).toBe(true);
    }
  });

  it.each(Object.keys(V3_SUMMARY))(
    "recomputes %s exactly as pre-registered",
    (id) => {
      const fixture = v3Fixtures.find((entry) => entry.id === id);
      if (!fixture) throw new Error(`missing fixture ${id}`);
      const actual = O.computeWaitLabel(fixture, { deadlineAt: performance.now() + 600_000 });
      expect(JSON.parse(JSON.stringify(actual))).toEqual(expectedDocument(id).result);
    },
    900_000,
  );
});

describe("independent supply laws", () => {
  it("reproduces the frozen cohort 0..2 and pinned cohort-3 dispatch expectations", () => {
    expect(() => O.verifyDispatchLaw()).not.toThrow();
  }, 120_000);

  it("derives box supports equal to the positive-mass set of independentBoxMass", () => {
    const laws = [
      ["regular-box-v1", O.REGULAR_BOX],
      ["box-ii-v1", O.BOX_II],
    ] as const;
    for (const [law, box] of laws)
      for (let count = 0; count <= 4; count++) {
        const support = [...O.boxSupport(box, count)].sort(
          (a, c) => a[0] - c[0] || a[1] - c[1] || a[2] - c[2],
        );
        expect([law, count, support]).toEqual([law, count, positiveBoxPoints(law, count)]);
      }
  });

  it("matches cohort-0 dispatch support to the independent cohort-0 mass", async () => {
    const support = O.dispatchSupport(0);
    const inSupport = new Set(support.map((t) => t.join(",")));
    const point = fc.oneof(
      fc.nat({ max: support.length - 1 }).map((index) => support[index] as Triple),
      fc.tuple(
        fc.nat({ max: 40 }),
        fc.nat({ max: 16 }),
        fc.nat({ max: 16 }),
      ) as fc.Arbitrary<Triple>,
    );
    await assertProperty(
      fc.property(point, (target) => {
        expect(independentDispatchZeroMass(target).n > 0n).toBe(inSupport.has(target.join(",")));
      }),
      property("dispatch-cohort0-support-positivity", 40, 240_000),
    );
  }, 300_000);
});

describe("wait-label properties", () => {
  it("evaluates the certificate boundary exactly in BigInt", async () => {
    const boundary = fc.record({
      uses: fc.integer({ min: 1, max: 10 }),
      a: fc.integer({ min: 1, max: 50 }),
      b: fc.integer({ min: 1, max: 50 }),
      offset: fc.constantFrom(-1n, 0n, 1n),
      scale: fc.bigInt({ min: 10n, max: 10n ** 30n }),
    });
    await assertProperty(
      fc.property(boundary, ({ uses, a, b, offset, scale }) => {
        const theta = q(a, b);
        // theta * rate = 10 n exactly at offset 0; strictly below/above otherwise.
        const rate = add(q(10n * BigInt(uses) * BigInt(b), BigInt(a)), q(offset, scale));
        const applies = offset >= 0n;
        expect(O.certificateApplies(theta, rate, uses)).toBe(applies);
        expect(O.compensationUnits(theta, [rate, rate, rate])[0] >= uses).toBe(applies);
      }),
      property("certificate-boundary-bigint", 500, 60_000),
    );
  }, 120_000);

  it("commutes the cohort union with the unit projection and matches brute force", async () => {
    const point = fc.tuple(
      fc.nat({ max: 40 }),
      fc.nat({ max: 6 }),
      fc.nat({ max: 6 }),
    ) as fc.Arbitrary<Triple>;
    const scenario = fc.record({
      cohorts: fc.array(fc.array(point, { minLength: 1, maxLength: 4 }), {
        minLength: 1,
        maxLength: 3,
      }),
      duplicateFirst: fc.boolean(),
      shared: fc.array(point, { minLength: 1, maxLength: 3 }),
      days: fc.array(fc.array(fc.constantFrom("c", "s"), { maxLength: 2 }), {
        minLength: 1,
        maxLength: 3,
      }),
      stock: fc.tuple(
        fc.nat({ max: 25 }),
        fc.nat({ max: 25 }),
        fc.nat({ max: 25 }),
      ) as fc.Arbitrary<Triple>,
    });
    await assertProperty(
      fc.property(scenario, ({ cohorts: raw, duplicateFirst, shared, days, stock }) => {
        const cohorts = duplicateFirst ? [...raw, raw[0] as Triple[]] : raw;
        const schedule = days.flatMap((laws, index) =>
          laws.map((lawId, event) => ({
            id: `e${index}:${event}`,
            day: index + 1,
            refs: [{ lawId, count: 1 }],
          })),
        );
        const support = (ref: O.LawRef, cohort: number) =>
          ref.lawId === "c" ? (cohorts[cohort] as Triple[]) : shared;
        const unit = (pieces: Triple) =>
          pieces.map((value, j) => Math.floor(((stock[j] as number) + value) / 10)).join(",");
        // Brute force: enumerate every receipt sequence of each fixed cohort.
        const pieceSets = cohorts.map((_, cohort) => {
          let current: Triple[] = [[0, 0, 0]];
          return days.map((_laws, index) => {
            for (const event of schedule.filter((e) => e.day === index + 1)) {
              const next: Triple[] = [];
              for (const base of current)
                for (const gain of support(event.refs[0] as O.LawRef, cohort))
                  next.push([base[0] + gain[0], base[1] + gain[1], base[2] + gain[2]]);
              current = next;
            }
            return current;
          });
        });
        const ids = cohorts.map((_, cohort) => cohort);
        const actual = O.reachableUnits(stock, schedule, days.length, ids, support).map((units) =>
          units.map((u) => u.join(",")),
        );
        days.forEach((_laws, index) => {
          const projectThenUnion = new Set(
            pieceSets.flatMap((sets) => (sets[index] ?? []).map(unit)),
          );
          const unionThenProject = new Set(
            [
              ...new Set(pieceSets.flatMap((sets) => (sets[index] ?? []).map((t) => t.join(",")))),
            ].map((key) => {
              const [b = 0, p = 0, y = 0] = key.split(",").map(Number);
              return unit([b, p, y]);
            }),
          );
          expect([...projectThenUnion].sort()).toEqual([...unionThenProject].sort());
          expect([...(actual[index] ?? [])].sort()).toEqual([...projectThenUnion].sort());
        });
      }),
      property("cohort-union-commutation", 200, 120_000),
    );
  }, 180_000);
});

const stateArb = fc
  .record({
    sr: fc.boolean(),
    level: fc.integer({ min: 0, max: 14 }),
    expStep: fc.integer({ min: 0, max: 29 }),
  })
  .map(({ sr, level, expStep }) => ({
    grade: sr ? ("SR" as const) : ("R" as const),
    level,
    exp: 100 * (sr ? expStep : expStep % 10),
  }));
const priceArb = fc
  .tuple(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 20 }))
  .map(([n, d]) => q(n, d));

describe("wait-label engine properties", () => {
  it("matches n=1 batches and V* to the independent single-use Bellman oracle", async () => {
    const scenario = fc.record({
      state: stateArb,
      units: fc.tuple(fc.nat({ max: 2 }), fc.nat({ max: 2 }), fc.nat({ max: 2 })),
      remainder: fc.tuple(fc.nat({ max: 9 }), fc.nat({ max: 9 }), fc.nat({ max: 9 })),
      prices: fc.tuple(priceArb, priceArb, priceArb),
    });
    await assertProperty(
      fc.property(scenario, ({ state, units, remainder, prices }) => {
        const unitStock: Triple = units;
        const pieces = mapTriple(unitStock, (u, j) => 10 * u + remainder[j]);
        const reference = createOracleEvaluator(prices)({ ...state, stock: pieces });
        const engine = O.createWaitLabelEngine(prices, units[0] + units[1] + units[2]);
        const root = engine.value(state, unitStock);
        const exact = engine.toExact(root);
        expect(compareValue(exact, reference)).toBe(0);
        expect(exact.consumed).toEqual([...reference.consumed]);
        const mask = reference.ties.reduce(
          (bits, action) =>
            bits | ({ blue: 1, purple: 2, yellow: 4, STOP: 8, DONE: 0 } as const)[action],
          0,
        );
        expect(root.ties).toBe(mask);
        ([0, 1, 2] as const).forEach((color) => {
          const kit = O.KITS[color];
          if (units[color] < 1) return;
          const single = reference.candidates.get(kit);
          if (!single) throw new Error(`reference candidate ${kit} missing`);
          expect(
            compareValue(engine.toExact(engine.batch(state, unitStock, color, 1)), single),
          ).toBe(0);
        });
      }),
      property("batch-n1-equals-single-use", 150, 120_000),
    );
  }, 180_000);

  /** Why the certificate theta*rate_k >= 10n (so m_k >= n) excludes a P crossing:
   * (i) P*(s, .) is nondecreasing in the unit stock: extra units may stay unused.
   * (ii) P*(., u) is nondecreasing along every transition: for each kit, both the
   *      great-success and the normal successor s' of s satisfy P*(s', u) >= P*(s, u)
   *      (a use never moves the game backwards).
   * (iii) The batch at the joint point u + m spends at most n units of kit k, all
   *      covered by m_k >= n, so every batch path ends in a state s' reached from s
   *      by transitions, followed by optimal play from a stock r >= u (componentwise).
   *      By (ii) iterated and (i), P*(s', r) >= P*(s', u) >= P*(s, u); the batch P is
   *      a convex combination of such endpoint values, hence P_batch(s, u + m) >=
   *      P*(s, u). Equality is possible (REG-WL-1), so ties never cross.
   * The property below checks the conclusion together with lemmas (i) and (ii) on
   * the sampled state and stock; stocks up to 6 units per kit give batches of up to
   * 6 uses and support units up to 11 per kit. */
  it("certificate theta*rate_k >= 10n: waiting never has strictly higher P", async () => {
    const scenario = fc.record({
      state: stateArb,
      stock: fc.tuple(fc.nat({ max: 6 }), fc.nat({ max: 6 }), fc.nat({ max: 6 })),
      extra: fc.tuple(fc.nat({ max: 5 }), fc.nat({ max: 5 }), fc.nat({ max: 5 })),
      surplus: fc.tuple(fc.nat({ max: 2 }), fc.nat({ max: 2 }), fc.nat({ max: 2 })),
      prices: fc.tuple(priceArb, priceArb, priceArb),
    });
    await assertProperty(
      fc.property(scenario, ({ state, stock, extra, surplus, prices }) => {
        const x: Triple = stock;
        const u = mapTriple(x, (value, j) => value + extra[j]);
        const engine = O.createWaitLabelEngine(prices, u[0] + u[1] + u[2] + 6 + 6 + 1);
        const batch = O.recommendBatch(engine, state, x, 10);
        if (!batch) return;
        // Compensation with m_k >= n (certificate holds) and arbitrary other kits.
        const m = makeTriple((j) => (j === batch.kit ? batch.uses : 0) + surplus[j]);
        const now = engine.batch(
          state,
          mapTriple(u, (value, j) => value + m[j]),
          batch.kit,
          batch.uses,
        );
        const wait = engine.value(state, u).P;
        // P-only contract: the certificate excludes a P crossing at every support unit.
        expect(wait <= now.P).toBe(true);
        for (const j of [0, 1, 2] as const) {
          // Lemma (i).
          expect(
            wait <=
              engine.value(
                state,
                makeTriple((i) => u[i] + (i === j ? 1 : 0)),
              ).P,
          ).toBe(true);
          // Lemma (ii): both successors of one use of kit j, with the same units.
          const canonical = canonicalState(state.grade, state.level, state.exp);
          if (canonical.grade === "SR" && canonical.level >= 15) continue;
          for (const next of [
            independentSuccess(canonical.grade, canonical.level),
            independentFailure(canonical.grade, canonical.level, canonical.exp, j),
          ])
            expect(wait <= engine.value(next, u).P).toBe(true);
        }
      }),
      property("certificate-probability-soundness", 300, 240_000),
    );
  }, 300_000);
});

describe("named regressions", () => {
  /** REG-WL-1 certificate-lex-burden-crossing. Found by the earlier lexicographic
   * property "certificate-never-crosses" (own runner, seed 20261014, path
   * 27:8:9:5:5:5:7:6:7:10:11:10:12:10:10:10:14:10:10:10:10:10, fast-check 4.10.2,
   * generator-source sha256 9890e62a0db8b526226c6852c150c28d14e5a1c6c743e90d0e500101e79faf66,
   * oracle sha256 0923edf23623a5dd9bce1d5cf8f80f570204a63febf531906bdb3f59c402c368).
   * Minimized input: SR13/EXP1300, stock units [1,1,0], support units [1,1,2],
   * prices [1,1,1]; batch purple x1, compensation m = [0,1,0] so the certificate
   * holds. Contract (P-only): no crossing, since P is equal (1 = 1). Informational:
   * the P/B/C comparison of the same pair prefers waiting through burden B. */
  it("REG-WL-1: certificate implies no P crossing; a B-only crossing exists there", () => {
    const prices: QTriple = [q(1), q(1), q(1)];
    const state = { grade: "SR" as const, level: 13, exp: 1300 };
    const engine = O.createWaitLabelEngine(prices, 8);
    const batch = O.recommendBatch(engine, state, [1, 1, 0], 10);
    expect(batch).toEqual({ kit: 1, uses: 1 });
    // Compensation m = [0, 1, 0]: m_purple = n = 1, i.e. the certificate holds.
    // Independent single-use Bellman oracle in pieces (n = 1 batch = single use).
    const evaluate = createOracleEvaluator(prices);
    const wait = evaluate({ ...state, stock: [10, 10, 20] });
    const now = evaluate({ ...state, stock: [10, 20, 20] }).candidates.get("purple");
    if (!now) throw new Error("purple candidate missing");
    expect(O.certificateApplies(q(1), q(10), 1)).toBe(true);
    // Contract: equal P, hence no P crossing (independent oracle and this engine).
    expect([wait.P, now.P]).toEqual([q(1), q(1)]);
    const engineWait = engine.value(state, [1, 1, 2]);
    const engineNow = engine.batch(state, [1, 2, 2], 1, 1);
    expect(engineWait.P > engineNow.P).toBe(false);
    // Informational bCrossing: P/B/C prefers waiting through B.
    expect(compareValue(wait, now)).toBe(1);
    expect(engine.compare(engineWait, engineNow)).toBe(1);
  });

  /** REG-WL-2 joint compensation point. Reviewer witness with two nonzero
   * compensation components, obtained by a test-only rate override (the
   * product-derived purple rate ~3.59 is replaced by exactly 10, so m_purple = 1).
   * SR11/EXP200, stock units x = [2,0,3], price basis [20,0,30], support unit
   * u = [4,3,3], m = [2,1,0]; recommended batch yellow x3 (no certificate). Contract:
   * batch-now is evaluated once at the joint point u + m = [6,4,3]; its P exceeds
   * waiting, so u does not cross. Evaluating each compensation axis separately
   * ([6,3,3] or [4,4,3]) would report a crossing at both endpoints. */
  it("REG-WL-2: compensation is added jointly (u + m), not per axis", () => {
    const fixture = fixtures.find((entry) => entry.id === "SR10");
    if (!fixture) throw new Error("missing SR10");
    const product = O.independentRates(fixture);
    const rates: QTriple = [product[0], q(10), product[2]];
    const m = O.compensationUnits(q(1), rates);
    expect(m).toEqual([2, 1, 0]);
    const prices = O.independentPrices(rates, [20, 0, 30]);
    const state = { grade: "SR" as const, level: 11, exp: 200 };
    const engine = O.createWaitLabelEngine(prices, 16);
    const batch = O.recommendBatch(engine, state, [2, 0, 3], 10);
    expect(batch).toEqual({ kit: 2, uses: 3 });
    if (!batch) throw new Error("missing batch");
    expect(O.certificateApplies(q(1), rates[2], 3)).toBe(false);
    const u: Triple = [4, 3, 3];
    const p = (value: O.EngineValue) => engine.toExact(value).P;
    // Waiting value cross-checked against the independent single-use Bellman oracle.
    expect(p(engine.value(state, u))).toEqual(q(6516188709953095252193n, 7812500000000000000000n));
    expect(createOracleEvaluator(prices)({ ...state, stock: [40, 30, 30] }).P).toEqual(
      p(engine.value(state, u)),
    );
    const at = (point: Triple) => p(engine.batch(state, point, 2, 3));
    expect(at([6, 4, 3])).toEqual(
      q(13065176545936002589963287643579n, 15625000000000000000000000000000n),
    );
    expect(at([6, 3, 3])).toEqual(
      q(100266362634124788949928272913n, 125000000000000000000000000000n),
    );
    expect(at([4, 4, 3])).toEqual(q(12806459934812364323589931n, 15625000000000000000000000n));
    expect(O.classifyWait(engine, state, u, m, batch).probability).toBe(false);
    // The per-axis reading would cross at both single-axis endpoints.
    for (const axis of [
      [2, 0, 0],
      [0, 1, 0],
    ] as const)
      expect(O.classifyWait(engine, state, u, axis, batch).probability).toBe(true);
  });
});

/** All 600 canonical grid states (R/SR, levels 0..14, 100-exp steps), SR15+ removed. */
function tieCensusGrid() {
  const grid: ReturnType<typeof canonicalState>[] = [];
  for (const grade of ["R", "SR"] as const)
    for (let level = 0; level <= 14; level++)
      for (let step = 0; step < (grade === "SR" ? 30 : 10); step++) {
        const canonical = canonicalState(grade, level, 100 * step);
        if (!(canonical.grade === "SR" && canonical.level >= 15)) grid.push(canonical);
      }
  return grid;
}

/** Unit stocks [0..4]^3 with priceBasisStock = 10 * units. */
function tieCensusStocks() {
  const stocks: Triple[] = [];
  for (let b = 0; b <= 4; b++)
    for (let p = 0; p <= 4; p++) for (let y = 0; y <= 4; y++) stocks.push([b, p, y]);
  return stocks;
}

/** Runs the tie census under `rates`: every tied root must tie blue first with a
 * certified batch. Returns the tied-kit mask counts. */
function tieCensus(rates: ReturnType<typeof O.independentRates>) {
  const grid = tieCensusGrid();
  const masks = new Map<number, number>();
  for (const units of tieCensusStocks()) {
    const prices = O.independentPrices(
      rates,
      mapTriple(units, (unit) => 10 * unit),
    );
    const engine = O.createWaitLabelEngine(prices, units[0] + units[1] + units[2]);
    for (const canonical of grid) {
      const kits = engine.value(canonical, units).ties & 7;
      if ((kits & (kits - 1)) === 0) continue;
      masks.set(kits, (masks.get(kits) ?? 0) + 1);
      const batch = O.recommendBatch(engine, canonical, units, 10);
      expect(batch?.kit).toBe(0);
      expect(O.certificateApplies(q(1), rates[0], batch?.uses ?? 0)).toBe(true);
    }
  }
  return masks;
}

describe("tie path", () => {
  /** Census: all 600 grid states, unit stocks [0..4]^3, priceBasisStock = 10 * units,
   * product-derived rates. Every root with two or more exactly tied kits ties blue
   * with purple, and the first tied kit (blue) has a batch of at most 2 uses, so
   * theta * rate_blue (~20.8) >= 10 n: the certificate settles the base kit and a
   * switch to a later tied kit cannot be reached in this domain. (An exploratory
   * random search over 1041 piece stocks in [0, 69]^3 found 968 tied roots, all of
   * the same kind.) TIE-R5 in fixtures-tie.json is one such reachable tie. */
  it("every tied root in the census ties blue first with a certified batch", () => {
    const fixture = fixtures.find((entry) => entry.id === "SR10");
    if (!fixture) throw new Error("missing SR10");
    expect(tieCensusGrid()).toHaveLength(600);
    expect(tieCensusStocks()).toHaveLength(125);
    expect([...tieCensus(O.independentRates(fixture))]).toEqual([[3, 240]]);
  }, 120_000);

  it("pins TIE-R5 (root tie blue/purple) and recomputes it exactly", () => {
    const tieFixtures = O.loadWaitLabelFixtures("fixtures-tie.json");
    const raw = JSON.parse(
      readFileSync(resolve(O.FIXTURE_DIRECTORY, "fixtures-tie.json"), "utf8"),
    ) as {
      common: unknown;
      fixtures: { id: string; optimalKits: string[] }[];
    };
    const main = JSON.parse(
      readFileSync(resolve(O.FIXTURE_DIRECTORY, "fixtures.json"), "utf8"),
    ) as { common: unknown };
    expect(raw.common).toEqual(main.common);
    const fixture = tieFixtures.find((entry) => entry.id === "TIE-R5");
    if (!fixture) throw new Error("missing TIE-R5");
    const document = expectedDocument("TIE-R5");
    expect(document.fixtureFileSha256).toBe(PINS["fixtures-tie.json"]);
    const rates = O.independentRates(fixture);
    const prices = O.independentPrices(rates, fixture.priceBasisStock);
    const units = mapTriple(fixture.stock, (pieces) => Math.floor(pieces / 10));
    const engine = O.createWaitLabelEngine(prices, units[0] + units[1] + units[2]);
    const ties = engine.value(fixture, units).ties;
    expect(O.KITS.filter((_, color) => ties & (1 << color))).toEqual(raw.fixtures[0]?.optimalKits);
    const actual = O.computeWaitLabel(fixture, { deadlineAt: performance.now() + 600_000 });
    expect(JSON.parse(JSON.stringify(actual))).toEqual(document.result);
  }, 900_000);

  /** Supply rules v3: the same census under the v3 rates again finds only blue/purple
   * root ties (240 roots), TIE-R5's state among them. Pre-registered by
   * `record V3-TIE-R5 900000 fixtures-v3-tie.json`. */
  it("pins V3-TIE-R5 (v3 root tie blue/purple), its v3 census and recomputes it exactly", () => {
    const pins = {
      "fixtures-v3-tie.json": "445f6c648cb500eada2f0f48b23369baaafb94804e068d497e294da64f02730f",
      "expected/V3-TIE-R5.json": "3d9ee840d9a3c565cab5644bda36a53e8bdf7ec6b4fb75f556adeda3ce32a4ec",
    };
    for (const [path, sha] of Object.entries(pins))
      expect([path, O.sha256(readFileSync(resolve(O.FIXTURE_DIRECTORY, path)))]).toEqual([
        path,
        sha,
      ]);
    type Raw = {
      common: unknown;
      fixtures: ({ id: string; optimalKits: string[] } & Record<string, unknown>)[];
    };
    const read = (name: string) =>
      JSON.parse(readFileSync(resolve(O.FIXTURE_DIRECTORY, name), "utf8")) as Raw;
    const raw = read("fixtures-v3-tie.json");
    expect(raw.common).toEqual(read("fixtures-v3.json").common);
    // Same state as the historical v2 tie; only the contract (common block) differs.
    const { id: _v2Id, ...v2State } = read("fixtures-tie.json").fixtures[0] ?? { id: "" };
    const { id, ...v3State } = raw.fixtures[0] ?? { id: "" };
    expect([id, v3State]).toEqual(["V3-TIE-R5", v2State]);
    const fixture = O.loadWaitLabelFixtures("fixtures-v3-tie.json").find(
      (entry) => entry.id === "V3-TIE-R5",
    );
    if (!fixture) throw new Error("missing V3-TIE-R5");
    const document = expectedDocument("V3-TIE-R5");
    expect(document.fixtureFileSha256).toBe(pins["fixtures-v3-tie.json"]);
    expect(document.result.certificateConsistent).toBe(true);
    const rates = O.independentRates(fixture);
    // Census under the v3 rates: blue/purple are the only tied kit pairs.
    expect([...tieCensus(rates)]).toEqual([[3, 240]]);
    const prices = O.independentPrices(rates, fixture.priceBasisStock);
    const units = mapTriple(fixture.stock, (pieces) => Math.floor(pieces / 10));
    const engine = O.createWaitLabelEngine(prices, units[0] + units[1] + units[2]);
    const ties = engine.value(fixture, units).ties;
    expect(O.KITS.filter((_, color) => ties & (1 << color))).toEqual(raw.fixtures[0]?.optimalKits);
    const actual = O.computeWaitLabel(fixture, { deadlineAt: performance.now() + 600_000 });
    expect(JSON.parse(JSON.stringify(actual))).toEqual(document.result);
  }, 900_000);
});
