import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import type { CertifiedInput, CertifiedOutput } from "../src/certified/types.ts";
import { type OracleInput, q, wire } from "./certified-staging-oracle.ts";
import { verifyActualWaiting } from "./certified-staging-oracle-certificates.ts";
import { independentFiniteWitnessInteger } from "./certified-staging-oracle-endpoints-integer.ts";
import { makeTriple } from "./certified-staging-oracle-tuples.ts";
import {
  type WaitingProofEntry,
  type WaitingProofSource,
  waitingProofSignature,
} from "./certified-staging-oracle-waiting-cache.ts";
import { independentFiniteWitness } from "./certified-staging-oracle-witness.ts";

const prices = [q(1, 21), q(1, 3), q(10, 13)] as const;
function artifact() {
  const parsed = JSON.parse(
    readFileSync(
      "scripts/certified-staging-oracle-fixtures/historical-r0-witness.json.txt",
      "utf8",
    ),
  ) as { input: CertifiedInput; records: { output: CertifiedOutput }[] };
  const record = parsed.records[0];
  assert(record);
  return { input: parsed.input, output: record.output };
}
function outcome(run: () => unknown) {
  try {
    return { value: run() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: { name: error.name, message: error.message } };
  }
}
function watchedEvery(values: unknown[], trace: string[], label: string) {
  return new Proxy(values, {
    get(target, key, receiver) {
      trace.push(`${label}:get:${String(key)}`);
      if (key === "every")
        return function (this: unknown[], callback: (...args: unknown[]) => unknown) {
          return Array.prototype.every.call(this, (value, index, array) => {
            trace.push(`${label}:callback:${index}`);
            return Reflect.apply(callback, undefined, [value, index, array]);
          });
        };
      return Reflect.get(target, key, receiver);
    },
  });
}

function observePublicStock(
  routine: (input: OracleInput) => unknown,
  kind: "dense" | "empty" | "sparse" | "extended" | "early" | "null",
) {
  const trace: string[] = [];
  let values: unknown[] = [10, 0, 0];
  if (kind === "empty") values = [];
  if (kind === "sparse") {
    values = [];
    values.length = 4;
    values[0] = 10;
  }
  if (kind === "extended") values.push(0);
  if (kind === "early") values = [0, 0, 0, 0];
  const stock = kind === "null" ? null : watchedEvery(values, trace, "stock");
  return {
    result: outcome(() =>
      Reflect.apply(routine, undefined, [{ grade: "SR", level: 14, exp: 2900, stock, prices }]),
    ),
    trace,
  };
}

function observeN0(
  verify: typeof verifyActualWaiting,
  kind: "dense" | "sparse" | "extended" | "early" | "undefined" | "stock-sparse" | "stock-extended",
) {
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
  const waitingValue = { ...value };
  output.waiting = {
    ...output.waiting,
    status: "certified",
    recommendedDays: 0,
    rangeBoundary: false,
    bestDayRange: [0, 0],
    value: waitingValue,
    successProbabilityInterval: { lower: one, upper: one },
    successImprovementUpperBound: zero,
  };
  const trace: string[] = [];
  let consumed: unknown[] = [zero, zero, zero];
  if (kind === "sparse") {
    consumed = [];
    consumed.length = 4;
    consumed[0] = zero;
  }
  if (kind === "extended" || kind === "early") consumed.push(zero);
  if (kind === "early") {
    consumed[0] = one;
    Object.defineProperty(consumed, "3", {
      get() {
        throw new TypeError("fourth consumed touched");
      },
    });
  }
  if (kind === "undefined") consumed[0] = undefined;
  Object.assign(waitingValue, { expectedConsumed: watchedEvery(consumed, trace, "consumed") });
  if (kind === "stock-sparse" || kind === "stock-extended") {
    const stock = kind === "stock-extended" ? [0, 0, 0, 0] : [];
    stock.length = 4;
    stock[0] = 0;
    Object.assign(input, { stock: watchedEvery(stock, trace, "stock") });
  }
  return { result: outcome(() => verify(input, output, prices, false)), trace };
}

type UnitRow = {
  id: string;
  input: Omit<CertifiedInput, "snapshot">;
  output: CertifiedOutput;
  independentCurrent: { checked: boolean; pass: boolean };
  independentPricing: { status: string };
};
type ExpandedScenario =
  | "normal"
  | "null"
  | "undefined"
  | "receipts-missing"
  | "outside"
  | "join-mismatch"
  | "notrun-null"
  | "getters";

// Synthetic controls only: no frozen historical file is rewritten or rehashed.
// Load the private validator function with its real body and mocked immutable
// proof records; remove only the CLI invocation to avoid historical regeneration.
function expandedFixture(sourcePath: string, scenario: ExpandedScenario) {
  const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  const template = artifact();
  const { snapshot: _snapshot, cohortWeights: _prior, ...baseInput } = template.input;
  const original = { sources: [{ path: "synthetic-origin", sha256: "b".repeat(64) }] };
  const profile = "synthetic-controls-not-historical-regeneration";
  const snapshot = "a".repeat(64);
  const rows = new Map<string, UnitRow>();
  const proofs = [];
  for (let index = 0; index < 294; index++) {
    const row: UnitRow = {
      id: `unit-${index}`,
      input: { ...baseInput, receivedEventIds: [`unit-receipt-${index}`] },
      output: index === 0 ? structuredClone(template.output) : template.output,
      independentCurrent: { checked: true, pass: true },
      independentPricing: { status: "PASS" },
    };
    if (index === 0) {
      if (scenario === "null" || scenario === "notrun-null")
        Object.assign(row.output.waiting, { strictBoundaryWitness: null });
      if (scenario === "undefined")
        Object.assign(row.output.waiting, { strictBoundaryWitness: undefined });
      if (scenario === "receipts-missing") {
        assert(row.output.waiting.strictBoundaryWitness);
        Object.assign(row.output.waiting.strictBoundaryWitness, { receipts: undefined });
      }
    }
    let status = index < 210 ? "PASS" : "NOTRUN";
    if (scenario === "notrun-null") {
      if (index === 0) status = "NOTRUN";
      if (index === 210) status = "PASS";
    }
    proofs.push({
      id: row.id,
      status,
      inputSha256: digest(JSON.stringify(row.input)),
      witnessSha256: digest(JSON.stringify(row.output.waiting.strictBoundaryWitness ?? null)),
    });
    rows.set(row.id, row);
  }
  if (scenario === "outside") rows.delete("unit-0");
  if (scenario === "join-mismatch") {
    const proof = proofs[0];
    assert(proof);
    proof.witnessSha256 = "f".repeat(64);
  }
  const trace: string[] = [];
  if (scenario === "getters") {
    const row = rows.get("unit-0");
    assert(row);
    const witness = row.output.waiting.strictBoundaryWitness;
    assert(witness);
    const receipts = witness.receipts;
    Object.defineProperty(witness, "receipts", {
      enumerable: true,
      get() {
        trace.push("receipts");
        return receipts;
      },
    });
    Object.defineProperty(row.output.waiting, "strictBoundaryWitness", {
      enumerable: true,
      get() {
        trace.push("witness");
        return witness;
      },
    });
  }
  const report = JSON.stringify({
    sourcesCurrentAtEnd: true,
    engineProfileCodeHash: profile,
    snapshotSha256: snapshot,
    originalSourceClosureSha256: digest(JSON.stringify(original.sources)),
    rows: proofs,
  });
  const proofSource = { path: "synthetic-report", sha256: digest(report) };
  const union = JSON.stringify({ proofFiles: [proofSource] });
  const remaining = { path: "synthetic-union", sha256: digest(union) };
  const files = new Map([
    ["synthetic-report", report],
    ["synthetic-union", union],
  ]);
  const dependencies: Record<string, unknown> = {
    "node:fs": {
      readFileSync(path: string) {
        trace.push(`read:${path}`);
        const text = files.get(path);
        assert(text, "Expected a synthetic immutable proof source");
        return Buffer.from(text);
      },
    },
    "node:os": {},
    "./certified-staging-approved-panel/v5/evidence.ts": {
      readV5Evidence() {
        throw new Error("Synthetic expanded-entry controls must not load published evidence");
      },
    },
    "./certified-staging-oracle.ts": { q },
    "./certified-staging-oracle-physical-supply.ts": {},
    "./certified-staging-oracle-relaxation-population.ts": {
      evidenceHash: digest,
      RELAXATION_POPULATION: { profile, snapshot, remaining },
    },
    "./certified-staging-oracle-tuples.ts": { makeTriple },
    "./certified-staging-oracle-waiting-cache.ts": { waitingProofSignature },
  };
  const code = transformSync(readFileSync(sourcePath, "utf8"), {
    loader: "ts",
    format: "cjs",
    target: "es2022",
  }).code.replace(/^main\(\);$/m, "");
  const expanded: (
    original: { sources: WaitingProofSource[] },
    rows: Map<string, UnitRow>,
    rates: typeof prices,
  ) => { entries: WaitingProofEntry[]; sources: WaitingProofSource[] } = new Function(
    "require",
    `${code}\nreturn expandedEntries;`,
  )((specifier: string) => {
    const dependency = dependencies[specifier];
    assert(dependency, `Expected validator dependency: ${specifier}`);
    return dependency;
  });
  return { run: () => expanded(original, rows, prices), trace };
}

describe("waiting external-coordinate and optional-witness controls", () => {
  it.each([independentFiniteWitnessInteger, independentFiniteWitness])(
    "retains sparse/extended stock callbacks and short-circuit",
    (routine) => {
      const expectedCallbacks = {
        dense: [0, 1, 2],
        empty: [],
        sparse: [0],
        extended: [0, 1, 2, 3],
      };
      for (const kind of ["dense", "empty", "sparse", "extended"] as const) {
        const observed = observePublicStock(routine, kind);
        expect(observed.result).toMatchObject({
          value: { P: q(1), B: q(10, 21), C: q(10), consumed: [q(10), q(0), q(0)] },
        });
        const callbacks = observed.trace.filter((event) => event.includes(":callback:"));
        expect(callbacks).toEqual(
          expectedCallbacks[kind].map((index) => `stock:callback:${index}`),
        );
      }
      const early = observePublicStock(routine, "early");
      expect(early.result).toMatchObject({ value: { P: q(0), B: q(0), C: q(0) } });
      expect(early.trace.filter((event) => event.includes(":callback:"))).toEqual([
        "stock:callback:0",
      ]);
    },
  );
  it("keeps native N0 consumed/stock operations for sparse and fourth coordinates", () => {
    for (const kind of ["dense", "sparse", "stock-sparse"] as const)
      expect(observeN0(verifyActualWaiting, kind).result).toMatchObject({
        value: { status: "PASS" },
      });
    expect(observeN0(verifyActualWaiting, "extended").result).toEqual({
      error: { name: "TypeError", message: "Cannot read properties of undefined (reading 'd')" },
    });
    expect(observeN0(verifyActualWaiting, "undefined").result).toEqual({
      error: {
        name: "TypeError",
        message: "Cannot read properties of undefined (reading 'numerator')",
      },
    });
    const early = observeN0(verifyActualWaiting, "early");
    expect(early.result).toMatchObject({
      value: {
        status: "FAIL",
        reason: "N0_reported_value_differs_from_independently_verified_current",
      },
    });
    expect(early.trace.filter((event) => event.includes(":callback:"))).toEqual([
      "consumed:callback:0",
    ]);
    expect(observeN0(verifyActualWaiting, "stock-extended").result).toEqual({
      value: { status: "NOTRUN", reason: "N0_current_exact_parity_not_established" },
    });
  });
  it("keeps synthetic full same-case joins and native missing witness errors", () => {
    const source = "scripts/validate-certified-staging-waiting-cache.ts";
    const normal = expandedFixture(source, "normal");
    const result = normal.run();
    expect(result.entries).toHaveLength(210);
    expect(result.entries.every((entry) => entry.check.receiptCount === 80)).toBe(true);
    for (const [scenario, name, message] of [
      ["null", "TypeError", "Cannot read properties of null (reading 'receipts')"],
      ["undefined", "TypeError", "Cannot read properties of undefined (reading 'receipts')"],
      ["receipts-missing", "TypeError", "Cannot read properties of undefined (reading 'length')"],
      ["outside", "Error", "Expanded proof outside original population"],
      ["join-mismatch", "Error", "Expanded full input/witness same-case join mismatch: unit-0"],
    ] as const)
      expect(outcome(expandedFixture(source, scenario).run)).toEqual({ error: { name, message } });
    // Null hashing is retained when a joined NOTRUN row never reads receipts.
    expect(expandedFixture(source, "notrun-null").run().entries).toHaveLength(210);
    const getters = expandedFixture(source, "getters");
    expect(getters.run().entries).toHaveLength(210);
    expect(getters.trace.slice(0, 2)).toEqual(["read:synthetic-union", "read:synthetic-report"]);
    expect(getters.trace.filter((event) => event === "witness")).toHaveLength(11);
    expect(getters.trace.filter((event) => event === "receipts")).toHaveLength(11);
  });
});
