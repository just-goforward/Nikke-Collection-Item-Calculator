import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CertifiedInput, CertifiedOutput } from "../src/certified/types.ts";
import {
  compareValue,
  createOracleEvaluator,
  type OracleInput,
  type QTriple,
  q,
  wire,
} from "./certified-staging-oracle.ts";
import { verifyActualWaiting } from "./certified-staging-oracle-certificates.ts";
import {
  createIndependentEndpointIntegerEvaluator,
  independentFiniteWitnessInteger,
} from "./certified-staging-oracle-endpoints-integer.ts";
import { makeTriple } from "./certified-staging-oracle-tuples.ts";
import {
  loadWaitingProofCache,
  type WaitingProofCacheDocument,
  waitingCacheBuilderSources,
  waitingProofMathSources,
  waitingProofSignature,
} from "./certified-staging-oracle-waiting-cache.ts";
import {
  createIndependentUnlimited,
  independentBoxMass,
  independentDispatchZeroMass,
  independentFiniteWitness,
} from "./certified-staging-oracle-witness.ts";

const prices: QTriple = [q(1, 21), q(1, 3), q(10, 13)];
const terminalValue = {
  P: q(1),
  B: q(0),
  C: q(0),
  consumed: [q(0), q(0), q(0)],
  nodes: 0,
  unlimitedNodes: 0,
};
function outcome(run: () => unknown) {
  try {
    return { value: run() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: { name: error.name, message: error.message } };
  }
}
function artifact() {
  const value = JSON.parse(
    readFileSync(
      "scripts/certified-staging-oracle-fixtures/historical-r0-witness.json.txt",
      "utf8",
    ),
  ) as { input: CertifiedInput; records: { output: CertifiedOutput }[] };
  const record = value.records[0];
  assert(record);
  return { input: value.input, output: record.output };
}
describe("waiting nonnull self-contained regression", () => {
  it("preserves terminal/nonterminal action shapes", () => {
    const solver = createIndependentUnlimited(prices);
    expect(solver.solve({ grade: "SR", level: 15, exp: 0 }).actions).toEqual([]);
    expect(solver.solve({ grade: "SR", level: 14, exp: 0 }).actions).toHaveLength(3);
  });
  it("matches the separately implemented rational oracle on finite stocks", () => {
    const rational = createOracleEvaluator(prices);
    for (const stock of [
      [0, 0, 0],
      [9, 19, 29],
      [10, 10, 10],
      [31, 24, 19],
      [100, 100, 100],
    ] as const) {
      for (const level of [14, 15]) {
        const input: OracleInput = { grade: "SR", level, exp: 0, stock, prices };
        const expected = rational(input);
        for (const actual of [
          independentFiniteWitnessInteger(input),
          independentFiniteWitness(input),
        ]) {
          expect(compareValue(actual, expected)).toBe(0);
          expect(actual.consumed).toEqual(expected.consumed);
        }
      }
    }
    // At SR14/2900, even one ordinary blue use crosses the terminal threshold.
    const oneUse = createIndependentUnlimited(prices).solve({ grade: "SR", level: 14, exp: 2900 });
    expect(oneUse.B).toEqual(q(10, 21));
    expect(oneUse.C).toEqual(q(10));
    expect(oneUse.consumed).toEqual([q(10), q(0), q(0)]);
  });
  it("keeps power admission, dense extension and reuse", () => {
    const run = createIndependentEndpointIntegerEvaluator(prices);
    const state = { grade: "SR", level: 15, exp: 0 } as const;
    for (const stock of [
      [0, 0, 0],
      [6000, 0, 0],
      [11, 24, 39],
    ] as const)
      expect(run({ ...state, stock })).toEqual(terminalValue);
    for (const stock of [
      [6010, 0, 0],
      [-1, 0, 0],
      [0.5, 0, 0],
      [NaN, 0, 0],
      [Infinity, 0, 0],
      [Number.MAX_SAFE_INTEGER + 1, 0, 0],
    ] as const)
      expect(outcome(() => run({ ...state, stock }))).toEqual({
        error: { name: "Error", message: "independent_endpoint_integer_power_admission" },
      });
    expect(outcome(() => Reflect.apply(run, undefined, [{ ...state, stock: null }]))).toEqual({
      error: { name: "TypeError", message: "Cannot read properties of null (reading 'reduce')" },
    });
    for (const stock of [[], [10], [0, 0, 0, 10]])
      expect(Reflect.apply(run, undefined, [{ ...state, stock }])).toEqual(terminalValue);
    expect(
      outcome(() => Reflect.apply(run, undefined, [{ ...state, stock: ["10", 0, 0] }])),
    ).toEqual({
      error: { name: "Error", message: "independent_endpoint_integer_power_admission" },
    });
    const input: OracleInput = { ...state, stock: [0, 0, 0], prices };
    for (const [budget, message] of [
      [{ maxMemoEntries: 0 }, "independent_endpoint_memo_budget"],
      [{ deadlineAt: -1 }, "independent_endpoint_time_budget"],
    ] as const)
      expect(outcome(() => independentFiniteWitnessInteger(input, budget))).toEqual({
        error: { name: "Error", message },
      });
  });
  it("retains callback and property-access order, including callback mutation", () => {
    // Exact native access trace independently captured at the specified baseline.
    const trace: string[] = [];
    const stock = new Proxy([11, 24, 39], {
      get(target, key, receiver) {
        trace.push(String(key));
        if (key === "1") target[2] = 29;
        return Reflect.get(target, key, receiver);
      },
    });
    const run = createIndependentEndpointIntegerEvaluator(prices);
    expect(Reflect.apply(run, undefined, [{ grade: "SR", level: 15, exp: 0, stock }])).toEqual(
      terminalValue,
    );
    expect(trace).toEqual([
      "reduce",
      "length",
      "0",
      "1",
      "2",
      "some",
      "length",
      "0",
      "1",
      "2",
      "Symbol(Symbol.iterator)",
      "length",
      "0",
      "length",
      "1",
      "length",
      "2",
      "length",
      "reduce",
      "length",
      "0",
      "1",
      "2",
    ]);
    expect(stock).toEqual([11, 24, 29]);
  });
});

describe("waiting getter and finite witness boundaries", () => {
  it("preserves failures when stock getters invalidate the admitted power bound", () => {
    const base: [number, number, number] = [0, 0, 0];
    const increasing = new Proxy(base, {
      get(target, key, receiver) {
        // Admission computed zero units before reading some. All later pieces
        // pass admission, but solve now looks up the unallocated first power.
        if (key === "some") target[0] = 10;
        return Reflect.get(target, key, receiver);
      },
    });
    const run = createIndependentEndpointIntegerEvaluator(prices);
    expect(outcome(() => run({ grade: "SR", level: 15, exp: 0, stock: increasing }))).toEqual({
      error: { name: "TypeError", message: "Cannot convert undefined to a BigInt" },
    });
    let first = true;
    const unstable = new Proxy<[number, number, number]>([0, 0, 0], {
      get(target, key, receiver) {
        if (key === "0" && first) {
          first = false;
          return NaN;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    // NaN total is not greater than 600; subsequent safe reads pass some.
    // solve uses index zero, but publicValue uses the retained NaN total.
    expect(outcome(() => run({ grade: "SR", level: 15, exp: 0, stock: unstable }))).toEqual({
      error: {
        name: "TypeError",
        message: "Cannot mix BigInt and other types, use explicit conversions",
      },
    });
    // Independent baseline results cover undefined remainder in the feasible
    // shortcut, undefined retained terminal P in a child, and root arithmetic.
    for (const pieces of [10, 20])
      for (const exp of [0, 2900]) {
        const stock = new Proxy<[number, number, number]>([0, 0, 0], {
          get(target, key, receiver) {
            if (key === "some") target[0] = pieces;
            return Reflect.get(target, key, receiver);
          },
        });
        const fresh = createIndependentEndpointIntegerEvaluator(prices);
        expect(outcome(() => fresh({ grade: "SR", level: 14, exp, stock }))).toEqual({
          error: {
            name: "TypeError",
            message: "Cannot mix BigInt and other types, use explicit conversions",
          },
        });
      }
  });
  it("keeps exact board masses independently captured from the frozen baseline", () => {
    // These values are sealed expectations, not recomputed from the implementation under test.
    const cases = [
      { target: [0, 0, 0], mass: q(47290016553932383n, 43432121536520402043n) },
      {
        target: [8, 0, 0],
        mass: q(289119369242478758127383200242815321n, 7297683389292147097419964363455382500n),
      },
      {
        target: [0, 8, 0],
        mass: q(
          410271435000725810650965156628096064352511465277652379n,
          1630559076592595401597295799491647398899673931536210937500n,
        ),
      },
      {
        target: [0, 0, 8],
        mass: q(
          2176747633756154561374752471934864217n,
          1955692494007557847227108156427624931000000n,
        ),
      },
    ] as const;
    for (const { target, mass } of cases) expect(independentDispatchZeroMass(target)).toEqual(mass);
    for (const target of [
      [-1, 0, 0],
      [0.5, 0, 0],
    ] as const)
      expect(independentDispatchZeroMass(target)).toEqual(q(0));
    for (const target of [[], [0], ["x", 0, 0]])
      expect(Reflect.apply(independentDispatchZeroMass, undefined, [target])).toEqual(q(0));
    expect(outcome(() => Reflect.apply(independentDispatchZeroMass, undefined, [null]))).toEqual({
      error: { name: "TypeError", message: "Cannot read properties of null (reading '0')" },
    });
    // One regular box: blue occurs with 4/5, purple with 1/5.
    expect(independentBoxMass("regular-box-v1", 1, [3, 0, 0])).toEqual(q(4, 5));
    expect(independentBoxMass("regular-box-v1", 1, [0, 1, 0])).toEqual(q(1, 5));
    expect(independentBoxMass("box-ii-v1", 1, [5, 0, 0])).toEqual(q(7, 10));
    expect(independentBoxMass("box-ii-v1", 1, [0, 2, 0])).toEqual(q(1, 5));
    expect(independentBoxMass("box-ii-v1", 1, [0, 0, 2])).toEqual(q(1, 10));
    for (const law of ["regular-box-v1", "box-ii-v1"] as const)
      for (const count of [0, 1, 4, -1, 0.5])
        expect(independentBoxMass(law, count, [3, 1, 0])).toEqual(q(0));
  });
  it("preserves N0 certification and baseline malformed vector failures", () => {
    const { input, output } = artifact();
    Object.assign(input, { grade: "SR", level: 15, exp: 0 });
    assert(output.current);
    const zero = wire(q(0)),
      one = wire(q(1));
    const value = {
      ...output.current.value,
      successP: one,
      weightedExpectedConsumptionB: zero,
      expectedTotalConsumptionC: zero,
      expectedConsumed: [zero, zero, zero] as const,
    };
    output.current.value = value;
    output.waiting = {
      ...output.waiting,
      status: "certified",
      recommendedDays: 0,
      rangeBoundary: false,
      bestDayRange: [0, 0],
      value,
      successProbabilityInterval: { lower: one, upper: one },
      successImprovementUpperBound: zero,
    };
    expect(verifyActualWaiting(input, output, prices, false).status).toBe("PASS");
    const cases = [
      { consumed: [], message: "Cannot read properties of undefined (reading 'numerator')" },
      { consumed: [zero], message: "Cannot read properties of undefined (reading 'numerator')" },
      {
        consumed: [zero, zero, zero, zero],
        message: "Cannot read properties of undefined (reading 'd')",
      },
      { consumed: null, message: "Cannot read properties of null (reading '0')" },
      { consumed: [null], message: "Cannot read properties of null (reading 'numerator')" },
    ];
    for (const { consumed, message } of cases) {
      const changed = structuredClone(output);
      assert(changed.waiting.value);
      Object.assign(changed.waiting.value, { expectedConsumed: consumed });
      expect(outcome(() => verifyActualWaiting(input, changed, prices, false))).toEqual({
        error: { name: "TypeError", message },
      });
    }
  });
});

describe("waiting source and cache boundaries", () => {
  it("preserves sealed source identities and price verification access order", () => {
    const { input, output } = artifact();
    assert(output.pricing);
    const weights = output.pricing.weights;
    const fixed = makeTriple((color) =>
      q(BigInt(weights[color].numerator), BigInt(weights[color].denominator)),
    );
    const snapshotSha256 = "a".repeat(64);
    const { snapshot: _snapshot, ...fullInput } = input;
    const signature = waitingProofSignature(fullInput, output, fixed, snapshotSha256);
    const document: WaitingProofCacheDocument = {
      version: "independent_waiting_exact_signature_cache_v1",
      oldProductProfile: "synthetic-controls-not-historical-regeneration",
      snapshotSha256,
      mathSources: waitingProofMathSources(),
      cacheBuilderSources: waitingCacheBuilderSources(),
      sourceReports: [],
      entries: [
        {
          ...signature,
          originalId: "control",
          check: { status: "PASS", reason: "synthetic-loader-controls-only" },
          sourceProof: { path: "control", sha256: "b".repeat(64) },
        },
      ],
      sourcesCurrentAtEnd: true,
    };
    mkdirSync(".certified-test-tmp", { recursive: true });
    const directory = mkdtempSync(join(".certified-test-tmp", "nonnull-waiting-"));
    function saved(value: WaitingProofCacheDocument, name: string) {
      const bytes = JSON.stringify(value),
        path = join(directory, name);
      writeFileSync(path, bytes);
      return { path, hash: createHash("sha256").update(bytes).digest("hex"), bytes };
    }
    const sealed = structuredClone(document);
    const source = sealed.mathSources[0];
    assert(source);
    source.sha256 = "f".repeat(64);
    const old = saved(sealed, "sealed-source-mismatch.json");
    expect(() => loadWaitingProofCache(old.path, old.hash)).toThrow(
      "Independent waiting cache mathematics source mismatch",
    );
    expect(readFileSync(old.path, "utf8")).toBe(old.bytes);
    const fresh = saved(document, "synthetic-current.json");
    const cache = loadWaitingProofCache(fresh.path, fresh.hash);
    expect(cache.find(input, output, fixed, snapshotSha256, true)?.key).toBe(signature.key);
    expect(cache.find(input, output, fixed, snapshotSha256, false)).toBeNull();
    expect(cache.find(input, output, fixed, "c".repeat(64), true)).toBeNull();
    const trace: string[] = [];
    const changed = structuredClone(output);
    assert(changed.pricing);
    changed.pricing.weights = new Proxy(changed.pricing.weights, {
      get(target, key, receiver) {
        trace.push(String(key));
        return Reflect.get(target, key, receiver);
      },
    });
    const watchedPrices = new Proxy(fixed, {
      get(target, key, receiver) {
        trace.push(`price:${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
    });
    cache.find(input, changed, watchedPrices, snapshotSha256, true);
    // Price comparison precedes canonical signature reads; every stays native.
    expect(trace.slice(0, 8)).toEqual([
      "every",
      "length",
      "0",
      "price:0",
      "1",
      "price:1",
      "2",
      "price:2",
    ]);
    const sparse: (typeof weights)[number][] = [];
    sparse.length = 4;
    sparse[0] = weights[0];
    for (const malformed of [
      [],
      sparse,
      [null],
      [...weights, wire(q(0))],
      [wire(q(0)), ...weights],
    ]) {
      const broken = structuredClone(output);
      assert(broken.pricing);
      Object.assign(broken.pricing, { weights: malformed });
      // Native every is vacuously true for an empty malformed vector. Pricing
      // diagnostics are not part of the mathematical signature; fixed prices are.
      if (malformed.length === 0 || malformed === sparse)
        expect(cache.find(input, broken, fixed, snapshotSha256, true)?.key).toBe(signature.key);
      else if (malformed[0]?.numerator === "0")
        expect(cache.find(input, broken, fixed, snapshotSha256, true)).toBeNull();
      else
        expect(outcome(() => cache.find(input, broken, fixed, snapshotSha256, true))).toEqual({
          error: {
            name: "TypeError",
            message:
              malformed.length === 1
                ? "Cannot read properties of null (reading 'numerator')"
                : "Cannot read properties of undefined (reading 'd')",
          },
        });
    }
  });
});
