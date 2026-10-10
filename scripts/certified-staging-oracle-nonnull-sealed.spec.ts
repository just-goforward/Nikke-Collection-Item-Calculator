import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { PHYSICAL_SOURCES } from "./certified-staging-approved-panel/v5/evidence.ts";
import type * as Oracle from "./certified-staging-oracle.ts";
import type * as Physical from "./certified-staging-oracle-physical-supply.ts";

const baselineRoot = "scripts/certified-staging-approved-panel/v2/historical/";
const oraclePath = "scripts/certified-staging-oracle.ts";
const physicalPath = "scripts/certified-staging-oracle-physical-supply.ts";
const gamePath = "shared/game.ts";
const oldCache = "benchmarks/results/certified-staging-validation-independent-physical-rates.json";
const newCache =
  "benchmarks/results/certified-staging-validation-independent-physical-rates-v5.json";
const oldSentinel = JSON.stringify({ sourceHash: "unrelated-historical-source", rate: [] });

function sourceText(root: string, path: string) {
  if (root && path === oraclePath) {
    return readFileSync(`${root}certified-staging-oracle.ts.txt`, "utf8");
  }
  if (root && path === physicalPath) {
    return readFileSync(`${root}certified-staging-oracle-physical-supply.ts.txt`, "utf8");
  }
  if (root && path === gamePath) return readFileSync(`${root}shared-game.ts.txt`, "utf8");
  return readFileSync(path, "utf8");
}

function environment(root: string, cache = new Map([[oldCache, oldSentinel]])) {
  const modules = new Map<string, Record<string, unknown>>();
  const reads: string[] = [];
  const writes: string[] = [];
  const sources = new Map<string, string>(
    PHYSICAL_SOURCES.map((path) => [path, sourceText(root, path)]),
  );
  const fs = {
    existsSync: (path: string) => cache.has(path),
    readFileSync: (path: string) => {
      reads.push(path);
      const value = sources.get(path) ?? cache.get(path);
      if (value === undefined) throw new Error(`Unexpected isolated read: ${path}`);
      return value;
    },
    writeFileSync: (path: string, text: string) => {
      writes.push(path);
      cache.set(path, text);
    },
  };
  function load(path: string): Record<string, unknown> {
    const existing = modules.get(path);
    if (existing) return existing;
    const source = sources.get(path);
    if (source === undefined) throw new Error(`Unexpected isolated module: ${path}`);
    const module = { exports: {} };
    const require = (specifier: string) => {
      if (specifier === "node:fs") return fs;
      if (specifier === "node:crypto") return { createHash };
      if (specifier === "node:assert/strict") return { default: assert, ...assert };
      if (specifier === "node:path") return nodePath;
      if (specifier === "../shared/game.ts") return load(gamePath);
      if (specifier === "./certified-staging-oracle.ts") return load(oraclePath);
      if (specifier === "../../certified-staging-oracle.ts") return load(oraclePath);
      if (specifier === "./history.ts")
        return load("scripts/certified-staging-approved-panel/v5/history.ts");
      if (specifier === "./certified-staging-approved-panel/v5/evidence.ts")
        return load("scripts/certified-staging-approved-panel/v5/evidence.ts");
      throw new Error(`Unexpected isolated import: ${specifier}`);
    };
    const code = transformSync(source, { loader: "ts", format: "cjs", target: "es2022" }).code;
    // Separate module closures and filesystem maps: neither source can reuse the
    // other's module memo or generated cold/warm cache.
    new Function("module", "exports", "require", "process", code)(module, module.exports, require, {
      argv: [],
    });
    modules.set(path, module.exports);
    return module.exports;
  }
  return {
    oracle: load(oraclePath) as typeof Oracle,
    physical: () => load(physicalPath) as typeof Physical,
    cache,
    sources,
    reads,
    writes,
  };
}
function outcome(run: () => unknown) {
  try {
    return { value: run() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: [error.name, error.message] };
  }
}
function watched(values: unknown[], trace: string[], label: string) {
  return new Proxy(values, {
    get(target, key, receiver) {
      trace.push(`${label}:${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
}
function sparse(first: unknown, third: unknown) {
  const values = new Array<unknown>(3);
  values[0] = first;
  values[2] = third;
  return values;
}
function serialize(value: unknown) {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "bigint") return entry.toString();
    if (entry instanceof Map) return [...entry];
    return entry;
  });
}

describe("sealed independent arithmetic migration", () => {
  it("uses immutable originals independently checked against the supplied baseline bytes", () => {
    for (const [path, hash] of [
      [oraclePath, "b92f50315a31d6b0f5e04054f5d220cf3103ef76b1d4a7c4d557da0a7964823b"],
      [physicalPath, "68686624ac22ab517283347c3cce7abb9a04d269eb2acb8b9ad3a63e8d5f13b5"],
    ] as const) {
      expect(createHash("sha256").update(sourceText(baselineRoot, path)).digest("hex")).toBe(hash);
    }
  });

  it("emits identical canonical JavaScript for type-only arithmetic and decoder changes", () => {
    const canonical = (text: string) =>
      transformSync(text, {
        loader: "ts",
        format: "esm",
        target: "es2022",
        minifySyntax: true,
        minifyWhitespace: true,
        minifyIdentifiers: false,
      }).code;
    function region(root: string, path: string, start: string, end: string) {
      const text = sourceText(root, path);
      const first = text.indexOf(start);
      const last = text.indexOf(end, first);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(last).toBeGreaterThan(first);
      return text.slice(first, last);
    }
    for (const [start, end] of [
      ["export function mapTriple", "export type OracleAction"],
      ["function weighted(", "export function canonicalState"],
    ] as const) {
      expect(canonical(region("", oraclePath, start, end))).toBe(
        canonical(region(baselineRoot, oraclePath, start, end)),
      );
    }
  });
});

describe("sealed Bellman values and stage boundaries", () => {
  it("matches exact Bellman values, actions, ties and memo nodes across all stage boundaries", () => {
    const baseline = environment(baselineRoot).oracle;
    const current = environment("").oracle;
    for (const grade of ["R", "SR"] as const) {
      for (const level of [0, 4, 5, 9, 10, 14, 15]) {
        for (const stock of [
          [0, 0, 0],
          [10, 0, 0],
          [0, 10, 0],
          [0, 0, 10],
          [29, 18, 11],
        ]) {
          const fixture = {
            grade,
            level,
            exp: grade === "R" ? 900 : 2900,
            stock,
            prices: [baseline.q(7, 211), baseline.q(7, 203), baseline.q(7, 147)],
          };
          expect(serialize(Reflect.apply(current.solveOracle, undefined, [fixture]))).toBe(
            serialize(Reflect.apply(baseline.solveOracle, undefined, [fixture])),
          );
        }
      }
    }
    const fixture = {
      grade: "SR" as const,
      level: 14,
      exp: 2900,
      stock: [10, 10, 10] as const,
      prices: [current.q(1, 10), current.q(1, 10), current.q(1, 10)] as const,
    };
    const result = current.solveOracle(fixture);
    expect([result.P, result.B, result.C, result.consumed, result.action, result.ties]).toEqual([
      current.q(1),
      current.q(1),
      current.q(10),
      [current.q(10), current.q(0), current.q(0)],
      "blue",
      ["blue", "purple", "yellow"],
    ]);
  });
});

describe("sealed malformed input and coercion behavior", () => {
  it("preserves malformed stock/price access, sparse and fourth coordinates and native errors", () => {
    function observe(api: typeof Oracle, kind: string) {
      const trace: string[] = [];
      let stock: unknown[] = [10, 0, 0];
      let prices: unknown[] = [api.q(1), api.q(2), api.q(3)];
      if (kind === "missing-stock") stock = [0, 0];
      if (kind === "sparse-stock") stock = sparse(0, 0);
      if (kind === "fourth-stock") stock.push(99);
      if (kind === "missing-prices") prices = [];
      if (kind === "sparse-prices") {
        prices = new Array<unknown>(3);
        prices[1] = api.q(2);
        prices[2] = api.q(3);
      }
      if (kind === "zero-denominator") prices[0] = { n: 1n, d: 0n };
      if (kind === "coercing-stock")
        stock[0] = {
          valueOf: () => {
            trace.push("stock:coerce");
            return 10;
          },
        };
      const result = outcome(() =>
        Reflect.apply(api.solveOracle, undefined, [
          {
            grade: "SR",
            level: 14,
            exp: 2900,
            stock: watched(stock, trace, "stock"),
            prices: watched(prices, trace, "prices"),
          },
        ]),
      );
      return { result, trace };
    }
    const baseline = environment(baselineRoot).oracle;
    const current = environment("").oracle;
    for (const kind of [
      "dense",
      "missing-stock",
      "sparse-stock",
      "fourth-stock",
      "missing-prices",
      "sparse-prices",
      "zero-denominator",
      "coercing-stock",
    ])
      expect(serialize(observe(current, kind))).toBe(serialize(observe(baseline, kind)));
    for (const index of [-1, 0, 1, 2, 3, NaN]) {
      expect(outcome(() => current.independentFailure("R", 4, 999, index))).toEqual(
        outcome(() => baseline.independentFailure("R", 4, 999, index)),
      );
      expect(outcome(() => current.independentProbability("SR", 14, index))).toEqual(
        outcome(() => baseline.independentProbability("SR", 14, index)),
      );
    }
    for (const args of [
      [1.5, 1],
      [1, 0],
      [undefined, 1],
      [1, undefined],
      [null, -3],
    ]) {
      expect(outcome(() => Reflect.apply(current.q, undefined, args))).toEqual(
        outcome(() => Reflect.apply(baseline.q, undefined, args)),
      );
    }
    function coercions(api: typeof Oracle) {
      const trace: string[] = [];
      const grade = {
        toString: () => {
          trace.push("grade");
          return "SR";
        },
      };
      const index = {
        toString: () => {
          trace.push("index");
          return "3";
        },
      };
      const level = {
        toString: () => {
          trace.push("level");
          return "14";
        },
      };
      const result = outcome(() =>
        Reflect.apply(api.independentProbability, undefined, [grade, level, index]),
      );
      const failure = outcome(() =>
        Reflect.apply(api.independentFailure, undefined, ["SR", 14, "2900", 3]),
      );
      return { result, failure, trace };
    }
    expect(coercions(current)).toEqual(coercions(baseline));
  });
});

describe("sealed callback and coordinate access ordering", () => {
  it("preserves receipt/cohort access and evaluation/tuple callback ordering", () => {
    function observe(api: typeof Oracle, kind: string) {
      const trace: string[] = [];
      const initial = watched([0, 0, 0, 7], trace, "initial");
      const receipts = watched(kind === "sparse" ? sparse(1, 3) : [1, 2, 3, 9], trace, "receipt");
      const cohorts =
        kind === "missing" ? [] : [[{ stock: receipts, probability: api.q(1) }], [], []];
      const weights = watched(
        kind === "missing-weight" ? [] : [api.q(1), api.q(0), api.q(0), api.q(99)],
        trace,
        "weights",
      );
      const result = outcome(() =>
        Reflect.apply(api.futureStockDistribution, undefined, [
          initial,
          [{ day: 1, byCohort: watched(cohorts, trace, "cohorts") }],
          1,
          weights,
        ]),
      );
      return { result, trace };
    }
    const baseline = environment(baselineRoot).oracle;
    const current = environment("").oracle;
    for (const kind of ["dense", "sparse", "missing", "missing-weight"]) {
      expect(serialize(observe(current, kind))).toBe(serialize(observe(baseline, kind)));
    }
    function callbacks(api: typeof Oracle) {
      const trace: unknown[] = [];
      const tupleValues = sparse(1, 3);
      tupleValues.push(4);
      const tuple = outcome(() =>
        Reflect.apply(api.mapTriple, undefined, [
          watched(tupleValues, trace as string[], "tuple"),
          (value: unknown, index: number) => {
            trace.push([value, index]);
            return value;
          },
        ]),
      );
      const average = outcome(() =>
        api.averageOracle(
          {
            grade: "SR",
            level: 14,
            exp: 2900,
            stock: [0, 0, 0],
            prices: [api.q(1), api.q(1), api.q(1)],
          },
          [
            { stock: [1, 2, 3], probability: api.q(1, 3) },
            { stock: [4, 5, 6], probability: api.q(2, 3) },
          ],
          (input) => {
            trace.push([...input.stock]);
            throw new RangeError("callback sentinel");
          },
        ),
      );
      const completedAverage = outcome(() =>
        api.averageOracle(
          {
            grade: "SR",
            level: 14,
            exp: 2900,
            stock: [0, 0, 0],
            prices: [api.q(1), api.q(1), api.q(1)],
          },
          [
            { stock: [1, 2, 3], probability: api.q(1, 3) },
            { stock: [4, 5, 6], probability: api.q(2, 3) },
          ],
          (input) => {
            trace.push(["evaluate", ...input.stock]);
            return {
              P: api.q(input.stock[0]),
              B: api.q(input.stock[1]),
              C: api.q(input.stock[2]),
              consumed: [api.q(0), api.q(0), api.q(0)],
              action: "STOP",
              ties: ["STOP"],
              candidates: new Map(),
              nodes: 0,
            };
          },
        ),
      );
      const made = outcome(() =>
        api.makeTriple((index) => {
          trace.push(["make", index]);
          if (index === 2) throw new RangeError("third callback");
          return index;
        }),
      );
      return { tuple, average, completedAverage, made, trace };
    }
    expect(callbacks(current)).toEqual(callbacks(baseline));
  });
});

it("genuinely enumerates equal isolated original/current ordered cohorts without result caches", () => {
  const baseline = environment(baselineRoot);
  const current = environment("");
  const oldCohorts = baseline.physical().independentDispatchExpectations();
  const newCohorts = current.physical().independentDispatchExpectations();
  expect(newCohorts).toEqual(oldCohorts);
  expect(newCohorts).toHaveLength(3);
  expect(newCohorts.map((cohort) => cohort.length)).toEqual([3, 3, 3]);
  expect(current.writes).toEqual([]);
  expect(current.cache.has(newCache)).toBe(false);
  expect(current.cache.get(oldCache)).toBe(oldSentinel);
}, 1_200_000);
