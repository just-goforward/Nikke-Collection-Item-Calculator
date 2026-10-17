import { readFileSync } from "node:fs";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import type { WireQ } from "../shared/certifiedRational.ts";
import {
  CERTIFIED_PHYSICAL_LAW_VERSION,
  CERTIFIED_SUPPLY_LAWS,
} from "../shared/certifiedSupplyLaws.ts";
import { DEFAULT_PERSONAL_COHORT_WEIGHTS } from "../shared/certifiedSupplyModel.ts";
import { CERTIFIED_WASM_HASH } from "../shared/generated/certifiedWasmBuild.ts";
import {
  assertProperty,
  expectDefectProperty,
  type PropertyIdentity,
} from "../shared/propertyHarness.ts";
import { loadCertifiedWasm } from "../src/certified/wasmBackend.ts";

/* S1/P4. Raw ABI probe of the committed public/certified_solver.wasm. JSON text
 * goes straight into certified_input/certified_call; TS fromWire is never used.
 * Plan grammar (the only documented WireQ format, shared/certifiedRational.ts
 * fromWire and the staging lane's WIRE_* patterns): numerator /^-?\d+$/,
 * denominator /^\d+$/ and nonzero; the value is the JS BigInt of the text, so
 * "05" and "-0" are in the grammar (values 5 and 0) while "+5", "1_0", " 5" and
 * "" are not. Rust echoes accepted values through recurringRate[0], which equals
 * dispatchExpected[0][0] exactly when the only positive prior is cohort 0. */

const WASM_PATH = "public/certified_solver.wasm";
const IDENTITY: PropertyIdentity = {
  file: "scripts/certified-wasm-raw-abi.property.spec.ts",
  generatorSource: readFileSync("scripts/certified-wasm-raw-abi.property.spec.ts", "utf8"),
  sources: {
    "rust/certified/src/lib.rs": readFileSync("rust/certified/src/lib.rs", "utf8"),
    "rust/certified/src/supply.rs": readFileSync("rust/certified/src/supply.rs", "utf8"),
    "rust/certified/src/supply/v3_gate.rs": readFileSync(
      "rust/certified/src/supply/v3_gate.rs",
      "utf8",
    ),
  },
  extra: { certifiedWasmSha256: CERTIFIED_WASM_HASH },
};
const NUM_RUNS = 100;
const TIME_LIMIT_MS = 15_000;
const HARD_DEADLINE_MS = 25_000;

type RawExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  certified_input(length: number): number;
  certified_call(): void;
  certified_output_ptr(): number;
  certified_output_len(): number;
};
let exports: RawExports;
beforeAll(async () => {
  // loadCertifiedWasm authenticates the bytes against CERTIFIED_WASM_HASH.
  const module = await loadCertifiedWasm(async () => readFileSync(WASM_PATH));
  exports = new WebAssembly.Instance(module, {
    certified: { now_ms: () => performance.now() },
  }).exports as RawExports;
});

function rawCall(text: string): { value?: unknown; error?: string } {
  const bytes = new TextEncoder().encode(text);
  const pointer = exports.certified_input(bytes.byteLength);
  new Uint8Array(exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
  exports.certified_call();
  const output = new Uint8Array(
    exports.memory.buffer,
    exports.certified_output_ptr(),
    exports.certified_output_len(),
  );
  return JSON.parse(new TextDecoder().decode(output)) as { value?: unknown; error?: string };
}
const zero = { numerator: "0", denominator: "1" };
const one = { numerator: "1", denominator: "1" };
/** Rust's parsed value of a WireQ, or its error code. */
function echo(
  numerator: string,
  denominator: string,
  supply: {
    /** Absent and undefined both omit the field from the serialized model. */
    snapshotVersion?: string | undefined;
    laws?: readonly unknown[];
    populationPrior?: readonly WireQ[];
  } = {},
): { value?: string; error?: string } {
  const basis = 2_000_000_000; // keeps rate + basis positive for every probed value
  const text = JSON.stringify({
    op: "configureSupply",
    basis: [basis, basis, basis],
    stock: [0, 0, 0],
    sid: 0,
    deadline: performance.now() + 60_000,
    model: {
      snapshotVersion: Object.hasOwn(supply, "snapshotVersion")
        ? supply.snapshotVersion
        : "certified-daily-v2",
      events: [],
      laws: supply.laws ?? [],
      priors: [one, zero, zero, zero],
      populationPrior: supply.populationPrior ?? DEFAULT_PERSONAL_COHORT_WEIGHTS,
      dispatch: [{ lawId: "dispatch-board-v1", count: 1 }],
      shop: [],
      solo: [],
      cadence: one,
      dispatchExpected: [
        [{ numerator, denominator }, zero, zero],
        [zero, zero, zero],
        [zero, zero, zero],
        [zero, zero, zero],
      ],
      classes: [],
    },
  });
  const response = rawCall(text);
  if (response.error !== undefined) return { error: response.error };
  const rate = (response.value as { recurringRate: { numerator: string; denominator: string }[] })
    .recurringRate[0];
  return { value: `${rate?.numerator}/${rate?.denominator}` };
}

/** Plan grammar oracle: canonical "n/d" of the JS BigInt values, or null if outside. */
function planValue(numerator: string, denominator: string): string | null {
  if (!/^-?\d+$/.test(numerator) || !/^\d+$/.test(denominator)) return null;
  let n = BigInt(numerator);
  let d = BigInt(denominator);
  if (d === 0n) return null;
  let a = n < 0n ? -n : n;
  let b = d;
  while (b) [a, b] = [b, a % b];
  if (a > 1n) {
    n /= a;
    d /= a;
  }
  return `${n}/${d}`;
}
function agrees(numerator: string, denominator: string): boolean {
  const plan = planValue(numerator, denominator);
  const actual = echo(numerator, denominator);
  return plan === null ? actual.error === "invalid_rational" : actual.value === plan;
}

describe("v3 raw-ABI declared law allowlist", () => {
  it("rejects an explicitly omitted snapshot version", () => {
    expect(echo("35", "70", { snapshotVersion: undefined })).toEqual({
      error: "invalid_wasm_request",
    });
  });
  it.each([
    { id: "unapproved-v3-law", kind: "box" },
    {
      id: "unapproved-v3-law",
      kind: "box",
      modelVersion: CERTIFIED_PHYSICAL_LAW_VERSION,
    },
    {
      id: "deterministic:10,10,0",
      kind: "box",
      modelVersion: CERTIFIED_PHYSICAL_LAW_VERSION,
    },
    ...CERTIFIED_SUPPLY_LAWS.map((law) => ({
      ...law,
      kind: law.kind === "dispatch" ? "box" : "dispatch",
    })),
    ...[undefined, null, "documented-physical-supply-v1", 2, {}].map((modelVersion) => ({
      id: "regular-box-v1",
      kind: "box",
      modelVersion,
    })),
    ...["outcomes", "outcomesByCohort"].map((field) => ({
      id: "regular-box-v1",
      kind: "box",
      modelVersion: CERTIFIED_PHYSICAL_LAW_VERSION,
      [field]:
        field === "outcomes"
          ? [{ pieces: [99, 0, 0], mass: one }]
          : Array.from({ length: 4 }, () => [{ pieces: [99, 0, 0], mass: one }]),
    })),
  ])("rejects declaration %j in v3 but preserves legacy acceptance", (law) => {
    const laws = [...CERTIFIED_SUPPLY_LAWS.filter((builtin) => builtin.id !== law.id), law];
    expect(echo("35", "70", { snapshotVersion: "certified-daily-v3", laws })).toEqual({
      error: "certified_v3_law_not_allowlisted",
    });
    for (const snapshotVersion of ["certified-daily-v1", "certified-daily-v2"]) {
      expect(echo("35", "70", { snapshotVersion, laws })).toEqual({ value: "1/2" });
    }
  });

  it("accepts the full documented physical law allowlist", () => {
    expect(
      echo("35", "70", {
        snapshotVersion: "certified-daily-v3",
        laws: CERTIFIED_SUPPLY_LAWS,
      }),
    ).toEqual({ value: "1/2" });
  });

  it.each([
    { name: "empty", laws: [] },
    ...CERTIFIED_SUPPLY_LAWS.flatMap((law, index) => [
      {
        name: `missing ${law.id}`,
        laws: CERTIFIED_SUPPLY_LAWS.filter((builtin) => builtin.id !== law.id),
      },
      {
        name: `duplicate ${law.id} replacing another descriptor`,
        laws: CERTIFIED_SUPPLY_LAWS.map((builtin, other) =>
          other === (index + 1) % CERTIFIED_SUPPLY_LAWS.length ? law : builtin,
        ),
      },
      { name: `extra duplicate ${law.id}`, laws: [...CERTIFIED_SUPPLY_LAWS, law] },
    ]),
  ])("rejects $name only in v3", ({ laws }) => {
    expect(echo("35", "70", { snapshotVersion: "certified-daily-v3", laws })).toEqual({
      error: "certified_v3_law_not_allowlisted",
    });
    for (const snapshotVersion of ["certified-daily-v1", "certified-daily-v2"]) {
      expect(echo("35", "70", { snapshotVersion, laws })).toEqual({ value: "1/2" });
    }
  });

  it(
    "checks every declaration's id, kind and model version through the raw ABI",
    async () => {
      const declaration = fc.record({
        id: fc.oneof(
          fc.constantFrom(...CERTIFIED_SUPPLY_LAWS.map((law) => law.id)),
          fc.string({ maxLength: 40 }),
        ),
        kind: fc.constantFrom("dispatch", "box", "unknown"),
        modelVersion: fc.option(
          fc.constantFrom(CERTIFIED_PHYSICAL_LAW_VERSION, "documented-physical-supply-v1"),
          { nil: undefined },
        ),
      });
      await assertProperty(
        fc.property(declaration, (law) => {
          const allowed = CERTIFIED_SUPPLY_LAWS.some(
            (builtin) =>
              law.id === builtin.id &&
              law.kind === builtin.kind &&
              law.modelVersion === builtin.modelVersion,
          );
          const result = echo("35", "70", {
            snapshotVersion: "certified-daily-v3",
            laws: [...CERTIFIED_SUPPLY_LAWS.filter((builtin) => builtin.id !== law.id), law],
          });
          return allowed
            ? result.value === "1/2"
            : result.error === "certified_v3_law_not_allowlisted";
        }),
        {
          name: "R2-01.v3-declared-law-allowlist",
          numRuns: NUM_RUNS,
          timeLimitMs: TIME_LIMIT_MS,
          identity: IDENTITY,
        },
      );
    },
    HARD_DEADLINE_MS,
  );

  it(
    "requires set equality rather than accepting missing or duplicate built-ins",
    async () => {
      await assertProperty(
        fc.property(
          fc.array(fc.constantFrom(...CERTIFIED_SUPPLY_LAWS), { maxLength: 5 }),
          (laws) => {
            const allowed =
              laws.length === CERTIFIED_SUPPLY_LAWS.length &&
              CERTIFIED_SUPPLY_LAWS.every((builtin) => laws.some((law) => law.id === builtin.id));
            const result = echo("35", "70", { snapshotVersion: "certified-daily-v3", laws });
            return allowed
              ? result.value === "1/2"
              : result.error === "certified_v3_law_not_allowlisted";
          },
        ),
        {
          name: "R1-08.v3-builtin-descriptor-set",
          numRuns: NUM_RUNS,
          timeLimitMs: TIME_LIMIT_MS,
          identity: IDENTITY,
        },
      );
    },
    HARD_DEADLINE_MS,
  );
});

describe("v3 raw-ABI population prior contract", () => {
  it.each(
    [
      [one, zero, zero, zero],
      [zero, zero, zero, one],
      [1, 1, 1, 1].map((n) => ({ numerator: String(n), denominator: "4" })),
      [1, 3, 2, 1].map((n) => ({ numerator: String(n), denominator: "7" })),
    ].map((populationPrior) => ({ populationPrior })),
  )("rejects noncontract population prior $populationPrior only in v3", ({ populationPrior }) => {
    const laws = CERTIFIED_SUPPLY_LAWS;
    expect(
      echo("35", "70", { snapshotVersion: "certified-daily-v3", laws, populationPrior }),
    ).toEqual({ error: "invalid_population_prior" });
    for (const snapshotVersion of ["certified-daily-v1", "certified-daily-v2"]) {
      expect(echo("35", "70", { snapshotVersion, laws, populationPrior })).toEqual({
        value: "1/2",
      });
    }
  });

  it("accepts equivalent rational priors and reordered built-in descriptors", () => {
    expect(
      echo("35", "70", {
        snapshotVersion: "certified-daily-v3",
        laws: [...CERTIFIED_SUPPLY_LAWS].reverse(),
        populationPrior: [2, 4, 6, 2].map((n) => ({
          numerator: String(n),
          denominator: "14",
        })),
      }),
    ).toEqual({ value: "1/2" });
  });
});

describe("P4 raw-ABI WireQ grammar of the committed WASM", () => {
  it("probes the echo channel with canonical values", () => {
    expect(echo("35", "70")).toEqual({ value: "1/2" });
    expect(echo("-3", "1")).toEqual({ value: "-3/1" });
    expect(echo("x", "1")).toEqual({ error: "invalid_rational" });
    // A non-string JSON value is a serde shape error, not a grammar decision.
    expect(rawCall('{"op":"configureSupply"}')).toMatchObject({ error: "invalid_wasm_request" });
  });

  it.each([
    ["5", "1", "5/1"],
    ["05", "1", "5/1"],
    ["-0", "1", "0/1"],
    ["0", "1", "0/1"],
    ["-12", "8", "-3/2"],
    ["1", "07", "1/7"],
  ])("accepts in-grammar numerator %j / denominator %j as %s", (numerator, denominator, value) => {
    expect(planValue(numerator, denominator)).toBe(value);
    expect(echo(numerator, denominator)).toEqual({ value });
  });

  it.each([
    [" 5", "1"],
    ["", "1"],
    ["5 ", "1"],
    ["-", "1"],
    ["1.0", "1"],
    ["1e3", "1"],
    ["0x1", "1"],
    ["--1", "1"],
    ["1", "0"],
    ["1", "-7"],
    ["1", "-0"],
    ["1", ""],
  ])("rejects out-of-grammar numerator %j / denominator %j", (numerator, denominator) => {
    expect(planValue(numerator, denominator)).toBeNull();
    expect(echo(numerator, denominator)).toEqual({ error: "invalid_rational" });
  });

  it.each([
    ["+5", "1"],
    ["1_0", "1"],
    ["1", "+7"],
    ["1", "7_0"],
    // Shrunk witness of P4.mixed-alphabet (seed 20260720).
    ["0", "+5"],
  ])(
    "DEFECT-P4-01 rejects out-of-grammar numerator %j / denominator %j",
    (numerator, denominator) => {
      expect(planValue(numerator, denominator)).toBeNull();
      const actual = echo(numerator, denominator);
      console.info(`[DEFECT-P4-01] ${JSON.stringify({ numerator, denominator, actual })}`);
      expect(actual).toEqual({ error: "invalid_rational" });
    },
  );

  it(
    "accepts every in-grammar WireQ with the JS BigInt value",
    async () => {
      const digits = fc
        .array(fc.constantFrom(..."0123456789"), { minLength: 1, maxLength: 9 })
        .map((chars) => chars.join(""));
      await assertProperty(
        fc.property(
          fc.boolean(),
          digits,
          digits.filter((text) => /[1-9]/.test(text)),
          (negative, numerator, denominator) =>
            agrees(`${negative ? "-" : ""}${numerator}`, denominator),
        ),
        {
          name: "P4.in-grammar",
          numRuns: NUM_RUNS,
          timeLimitMs: TIME_LIMIT_MS,
          identity: IDENTITY,
        },
      );
    },
    HARD_DEADLINE_MS,
  );

  it(
    "DEFECT-P4-01 accepts exactly the plan grammar over a mixed alphabet",
    async () => {
      const noisy = fc
        .array(fc.constantFrom(..."0159-+_ .ex"), { maxLength: 6 })
        .map((chars) => chars.join(""));
      await expectDefectProperty(
        fc.property(noisy, noisy, (numerator, denominator) => agrees(numerator, denominator)),
        {
          name: "P4.mixed-alphabet",
          numRuns: NUM_RUNS,
          timeLimitMs: TIME_LIMIT_MS,
          identity: IDENTITY,
        },
      );
    },
    HARD_DEADLINE_MS,
  );
});
