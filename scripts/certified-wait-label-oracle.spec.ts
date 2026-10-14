import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  add,
  compareValue,
  createOracleEvaluator,
  type QTriple,
  q,
  type Triple,
} from "./certified-staging-oracle.ts";
import {
  independentBoxMass,
  independentDispatchZeroMass,
} from "./certified-staging-oracle-witness.ts";
import * as O from "./certified-wait-label-oracle.ts";

const SPEC = "scripts/certified-wait-label-oracle.spec.ts";
const ORACLE = "scripts/certified-wait-label-oracle.ts";
const SEED = 20_261_014;
const property = (name: string, numRuns: number, timeLimitMs: number) => ({
  name,
  numRuns,
  timeLimitMs,
});
/** Fixed seed, capped runs, fast-check 4.10.2 interrupt plugin with failOnInterrupt.
 * A failure throws the replay record (seed, path, fast-check version, generator and
 * oracle source hashes, minimized counterexample) to be kept as a named regression. */
async function assertProperty<T>(
  check: fc.IRawProperty<T>,
  options: ReturnType<typeof property>,
): Promise<void> {
  const details = await fc.check(check, {
    seed: SEED,
    numRuns: options.numRuns,
    plugins: [fc.interruptAfterTimeLimit(options.timeLimitMs, { failOnInterrupt: true })],
  });
  if (!details.failed && !details.interrupted) return;
  throw new Error(
    `property_failed ${JSON.stringify({
      property: options.name,
      seed: details.seed,
      path: details.counterexamplePath,
      numRuns: details.numRuns,
      interrupted: details.interrupted,
      counterexample: details.counterexample === null ? null : fc.stringify(details.counterexample),
      error: details.errorInstance === null ? null : String(details.errorInstance),
      fastCheckVersion: fc.__version,
      generatorSourceSha256: O.sha256(readFileSync(SPEC)),
      oracleSourceSha256: O.sha256(readFileSync(ORACLE)),
    })}`,
  );
}

/** Pre-registered before any product comparison: sha256 of the committed bytes. */
const PINS: Record<string, string> = {
  "fixtures.json": "43dcdf764a2129b4087e8d42eacd7da2974fa66a6e7aa1b54ba9aa2ebbfbf37f",
  "expected/R0.json": "d8c6dfa638951aa2909d40ddb7879a788a6105cc8610ff4e694cb0b9f3731831",
  "expected/R10.json": "521b42a5a8b939d67c350105b04051687167f50b753a10cc681e6029bc828f34",
  "expected/R14.json": "edf2fcb99d7b1cc15e3000c7da4a780deb92e00e063c44614aae647ff10c4e23",
  "expected/SR5.json": "ac53cd569a568bdfdcb0a6df12eb193f4777e5c5fb7a395316e6a203503bf2aa",
  "expected/SR10.json": "54186f81f916698dfb294f76130ef5d3381a043c9ab34ed5728ca8d279efd259",
  "expected/SR13.json": "ae3575b90c97794cf9c5c35d7d9bd11e465718aabf80afaccad80c9667a1dd54",
};
/** Human-readable copy of the pre-registered results (kit, uses, label, per-day crossing counts). */
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
      expect(perDay.map((d) => d.supportUnitCount)).toEqual([9, 37, 92, 190, 335, 535, 1022]);
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
        const positive: Triple[] = [];
        for (let b = 0; b <= 5 * count; b++)
          for (let p = 0; p <= 2 * count; p++)
            for (let y = 0; y <= 2 * count; y++)
              if (independentBoxMass(law, count, [b, p, y]).n > 0n) positive.push([b, p, y]);
        const support = [...O.boxSupport(box, count)].sort(
          (a, c) => a[0] - c[0] || a[1] - c[1] || a[2] - c[2],
        );
        expect([law, count, support]).toEqual([law, count, positive]);
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
            ].map((key) => unit(key.split(",").map(Number) as unknown as Triple)),
          );
          expect([...projectThenUnion].sort()).toEqual([...unionThenProject].sort());
          expect([...(actual[index] ?? [])].sort()).toEqual([...projectThenUnion].sort());
        });
      }),
      property("cohort-union-commutation", 200, 120_000),
    );
  }, 180_000);

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

  it("matches n=1 batches and V* to the independent single-use Bellman oracle", async () => {
    const scenario = fc.record({
      state: stateArb,
      units: fc.tuple(fc.nat({ max: 2 }), fc.nat({ max: 2 }), fc.nat({ max: 2 })),
      remainder: fc.tuple(fc.nat({ max: 9 }), fc.nat({ max: 9 }), fc.nat({ max: 9 })),
      prices: fc.tuple(priceArb, priceArb, priceArb),
    });
    await assertProperty(
      fc.property(scenario, ({ state, units, remainder, prices }) => {
        const unitStock = units as unknown as Triple;
        const pieces = unitStock.map(
          (u, j) => 10 * u + (remainder[j] as number),
        ) as unknown as Triple;
        const reference = createOracleEvaluator(prices as QTriple)({ ...state, stock: pieces });
        const engine = O.createWaitLabelEngine(prices as QTriple, units[0] + units[1] + units[2]);
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
        O.KITS.forEach((kit, color) => {
          if ((units[color] as number) < 1) return;
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

  it("certificate theta*rate_k >= 10n: waiting never has strictly higher P", async () => {
    const scenario = fc.record({
      state: stateArb,
      stock: fc.tuple(fc.nat({ max: 3 }), fc.nat({ max: 3 }), fc.nat({ max: 3 })),
      extra: fc.tuple(fc.nat({ max: 2 }), fc.nat({ max: 2 }), fc.nat({ max: 2 })),
      surplus: fc.tuple(fc.nat({ max: 1 }), fc.nat({ max: 1 }), fc.nat({ max: 1 })),
      prices: fc.tuple(priceArb, priceArb, priceArb),
    });
    await assertProperty(
      fc.property(scenario, ({ state, stock, extra, surplus, prices }) => {
        const x = stock as unknown as Triple;
        const u = x.map((value, j) => value + (extra[j] as number)) as unknown as Triple;
        const bound = u.reduce((sum, value) => sum + value, 0) + 10 + 3;
        const engine = O.createWaitLabelEngine(prices as QTriple, bound);
        const batch = O.recommendBatch(engine, state, x, 10);
        if (!batch) return;
        // Compensation with m_k >= n (certificate holds) and arbitrary other kits.
        const m = surplus.map((value, j) =>
          j === batch.kit ? batch.uses + value : value,
        ) as unknown as Triple;
        const now = engine.batch(
          state,
          u.map((value, j) => value + (m[j] as number)) as unknown as Triple,
          batch.kit,
          batch.uses,
        );
        expect(engine.value(state, u).P <= now.P).toBe(true);
      }),
      property("certificate-probability-soundness", 300, 120_000),
    );
  }, 180_000);
});

describe("named regressions", () => {
  /** REG-WL-1 certificate-lex-burden-crossing. Found by property
   * "certificate-never-crosses" (lexicographic form): seed 20261014, path
   * 27:8:9:5:5:5:7:6:7:10:11:10:12:10:10:10:14:10:10:10:10:10, fast-check 4.10.2,
   * generator-source sha256 9890e62a0db8b526226c6852c150c28d14e5a1c6c743e90d0e500101e79faf66,
   * oracle sha256 0923edf23623a5dd9bce1d5cf8f80f570204a63febf531906bdb3f59c402c368.
   * Minimized input: SR13/EXP1300, stock units [1,1,0], support units [1,1,2],
   * prices [1,1,1]. Under the lexicographic P/B/C contract the certificate holds
   * (purple x1, m_purple = 1) yet waiting is strictly better through burden B at
   * equal P = 1, so the certificate is not a sound "7+" shortcut in general. */
  it("REG-WL-1: certificate holds but waiting is strictly better through B at equal P", () => {
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
    expect([wait.P, now.P]).toEqual([q(1), q(1)]);
    expect(compareValue(wait, now)).toBe(1);
    expect(
      engine.compare(engine.value(state, [1, 1, 2]), engine.batch(state, [1, 2, 2], 1, 1)),
    ).toBe(1);
  });
});
