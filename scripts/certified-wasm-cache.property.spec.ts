import { readFileSync } from "node:fs";
import fc from "fast-check";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type Q, q } from "../shared/certifiedRational.ts";
import {
  buildCertifiedSupplySnapshot,
  isCertifiedEventClaimable,
} from "../shared/certifiedSupply.ts";
import { dispatchLaw } from "../shared/certifiedSupplyLaws.ts";
import { CERTIFIED_WASM_HASH } from "../shared/generated/certifiedWasmBuild.ts";
import { assertProperty, type PropertyIdentity } from "../shared/propertyHarness.ts";
import { WorkBudget } from "../src/certified/budget.ts";
import type { CertifiedInput, CertifiedOutput, Triple } from "../src/certified/types.ts";
import { loadCertifiedWasm, WasmKernel } from "../src/certified/wasmBackend.ts";
import { solveCertifiedWasm } from "../src/certified/wasmSolver.ts";

/* S2/P5. Metamorphic cache contract with no product cache toggle: the result of
 * every call in a sequence on a warmed engine (pooled WASM instance, populated
 * Rust memo/relaxed/guidance tables, warm shared/certifiedSupplyLaws caches)
 * equals the result of the same call on genuinely fresh state:
 *  - kernel level: a new WebAssembly.Instance per call (kernels on a separate
 *    module are never disposed, so the idle pool can never hand one back);
 *  - solver level: vi.resetModules() and a re-import of the certified module
 *    graph (fresh rawCache/distributionCache and idle-instance pool) plus a
 *    module compiled by the re-imported loader.
 * Diagnostics (time, memory, payload accounting) are excluded by contract. */

const WASM_PATH = "public/certified_solver.wasm";
const IDENTITY: PropertyIdentity = {
  file: "scripts/certified-wasm-cache.property.spec.ts",
  generatorSource: readFileSync("scripts/certified-wasm-cache.property.spec.ts", "utf8"),
  sources: {
    "src/certified/wasmBackend.ts": readFileSync("src/certified/wasmBackend.ts", "utf8"),
    "src/certified/wasmSolver.ts": readFileSync("src/certified/wasmSolver.ts", "utf8"),
    "shared/certifiedSupplyLaws.ts": readFileSync("shared/certifiedSupplyLaws.ts", "utf8"),
    "rust/certified/src/lib.rs": readFileSync("rust/certified/src/lib.rs", "utf8"),
  },
  extra: { certifiedWasmSha256: CERTIFIED_WASM_HASH },
};
const NUM_RUNS = 25;
const TIME_LIMIT_MS = 25_000;
const HARD_DEADLINE_MS = 40_000;
const AS_OF = "2026-09-30T04:00:00.000Z";
const bytes = readFileSync(WASM_PATH);

const exact = (value: unknown) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? `${entry}n` : entry));

let warmModule: WebAssembly.Module;
let freshModule: WebAssembly.Module;
beforeAll(async () => {
  warmModule = await loadCertifiedWasm(async () => bytes);
  freshModule = await loadCertifiedWasm(async () => bytes);
  // Populate the shared JS law caches through the public API (no toggle).
  for (const cohort of [0, 1, 2, 3] as const) dispatchLaw(cohort);
});

type Op =
  | { op: "value"; sid: number; units: Triple; root: boolean }
  | { op: "unlimited"; sid: number }
  | { op: "solve"; sid: number; raw: Triple };
const triple = (max: number) =>
  fc.tuple(fc.nat({ max }), fc.nat({ max }), fc.nat({ max })) as fc.Arbitrary<Triple>;
const sidArbitrary = fc.integer({ min: 0, max: 600 });
const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    op: fc.constant("value" as const),
    sid: sidArbitrary,
    units: triple(14),
    root: fc.boolean(),
  }),
  fc.record({ op: fc.constant("unlimited" as const), sid: sidArbitrary }),
  fc.record({ op: fc.constant("solve" as const), sid: sidArbitrary, raw: triple(140) }),
);
/** A, B, ..., A: the first call is repeated last so a cache hit is always exercised. */
const sequenceArbitrary = fc
  .array(opArbitrary, { minLength: 1, maxLength: 4 })
  .map((ops) => [...ops, ops[0] as Op]);
const weightsArbitrary = fc
  .tuple(
    fc.integer({ min: 1, max: 40 }),
    fc.integer({ min: 1, max: 40 }),
    fc.integer({ min: 1, max: 40 }),
  )
  .map(([blue, purple, yellow]) => [q(1, blue), q(1, purple), q(1, yellow)] as [Q, Q, Q]);

const tally = {
  kernelCalls: 0,
  kernelErrors: {} as Record<string, number>,
  solverStatus: {} as Record<string, number>,
};
function apply(kernel: WasmKernel, step: Op): string {
  try {
    if (step.op === "value") return exact(kernel.value(step.sid, step.units, step.root));
    if (step.op === "unlimited") return exact(kernel.unlimited(step.sid));
    return exact(kernel.solve(step.sid, step.raw));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    tally.kernelErrors[reason] = (tally.kernelErrors[reason] ?? 0) + 1;
    return exact({ error: reason });
  }
}

describe("P5 warmed WASM kernel vs fresh instance per call", () => {
  it(
    "every call in a sequence on one initialized kernel equals the same call on a fresh instance",
    async () => {
      await assertProperty(
        fc.property(weightsArbitrary, sequenceArbitrary, (weights, sequence) => {
          const warm = new WasmKernel(warmModule, new WorkBudget({}, performance.now()));
          try {
            warm.initialize(weights);
            return sequence.every((step) => {
              tally.kernelCalls++;
              const warmResult = apply(warm, step);
              const fresh = new WasmKernel(freshModule, new WorkBudget({}, performance.now()));
              fresh.initialize(weights);
              const freshResult = apply(fresh, step);
              if (warmResult !== freshResult)
                throw new Error(`cache_divergence ${exact({ step, warmResult, freshResult })}`);
              return true;
            });
          } finally {
            warm.dispose();
          }
        }),
        {
          name: "P5.kernel-sequence",
          numRuns: NUM_RUNS,
          timeLimitMs: TIME_LIMIT_MS,
          identity: IDENTITY,
        },
      );
    },
    HARD_DEADLINE_MS,
  );
});

const baseSnapshot = buildCertifiedSupplySnapshot({
  asOf: AS_OF,
  revision: "wasm-cache-property",
  sourceHash: "a".repeat(64),
  soloPeriods: [],
  collaborationPeriods: [],
  sourceStatus: "healthy",
});
type Spec = { grade: "R" | "SR"; level: number; exp: number; stock: Triple; arrival: boolean };
function input(spec: Spec): CertifiedInput {
  const snapshot = structuredClone(baseSnapshot);
  const rule = snapshot.rules[0];
  if (!rule) throw new Error("snapshot_rule_missing");
  // Supply rules v3: the Wednesday weekly grants stay in every snapshot; an arrival
  // adds one dispatch on the H14 recommended-day boundary.
  const date = new Date(Date.parse("2026-09-30T00:00:00Z") + 14 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  snapshot.events = [
    ...snapshot.events.filter((event) => event.kind === "weekly-kits"),
    ...(spec.arrival
      ? [
          {
            id: `dispatch:${date}`,
            gameDate: date,
            at: `${date}T08:00:00.000Z`,
            kind: "dispatch" as const,
            status: "confirmed" as const,
            ruleId: rule.id,
            refs: [{ lawId: "dispatch-board-v1", count: 1 }],
          },
        ]
      : []),
  ];
  return {
    grade: spec.grade,
    level: spec.level,
    exp: spec.exp,
    stock: spec.stock,
    asOf: AS_OF,
    snapshot,
    receivedEventIds: snapshot.events
      .filter((event) => isCertifiedEventClaimable(snapshot, event, AS_OF))
      .map((event) => event.id),
  };
}
const behavior = (output: CertifiedOutput) =>
  exact({
    status: output.status,
    current: output.current,
    waiting: output.waiting,
    refusal: output.refusal,
    pricing: output.pricing,
    claimNotice: output.claimNotice,
  });
const specArbitrary: fc.Arbitrary<Spec> = fc
  .record({
    grade: fc.constantFrom<"R" | "SR">("R", "SR"),
    level: fc.integer({ min: 0, max: 15 }),
    expStep: fc.nat({ max: 29 }),
    stock: triple(60),
    arrival: fc.boolean(),
  })
  .map(({ grade, level, expStep, stock, arrival }) => ({
    grade,
    level,
    exp: level === 15 ? 0 : (expStep % (grade === "R" ? 10 : 30)) * 100,
    stock,
    arrival,
  }));

describe("P5 warmed solver path vs reset JS modules and fresh WASM", () => {
  it(
    "sequential solves on the pooled instance and warm law caches equal solves after a module reset",
    async () => {
      await assertProperty(
        fc.asyncProperty(
          fc
            .array(specArbitrary, { minLength: 1, maxLength: 2 })
            .map((specs) => [...specs, specs[0] as Spec]),
          async (specs) => {
            const warm = specs.map((spec) => {
              const output = solveCertifiedWasm(warmModule, input(spec));
              const key = `${output.status}:${output.waiting.status}:${output.waiting.recommendedDays}`;
              tally.solverStatus[key] = (tally.solverStatus[key] ?? 0) + 1;
              return behavior(output);
            });
            for (const [index, spec] of specs.entries()) {
              vi.resetModules();
              const backend = await import("../src/certified/wasmBackend.ts");
              const solver = await import("../src/certified/wasmSolver.ts");
              const module = await backend.loadCertifiedWasm(async () => bytes);
              const fresh = behavior(solver.solveCertifiedWasm(module, input(spec)));
              if (fresh !== warm[index])
                throw new Error(
                  `cache_divergence ${exact({ spec, index, warm: warm[index], fresh })}`,
                );
            }
            return true;
          },
        ),
        {
          name: "P5.solver-sequence",
          numRuns: NUM_RUNS,
          timeLimitMs: TIME_LIMIT_MS,
          identity: IDENTITY,
        },
      );
    },
    HARD_DEADLINE_MS,
  );

  it("compared mostly successful calls, not only matching errors", () => {
    console.info(`[P5 tally] ${JSON.stringify(tally)}`);
    const errors = Object.values(tally.kernelErrors).reduce((sum, count) => sum + count, 0);
    expect(tally.kernelCalls).toBeGreaterThanOrEqual(2 * NUM_RUNS);
    expect(errors * 2).toBeLessThan(tally.kernelCalls);
    expect(tally.solverStatus["refused:unresolved:null"] ?? 0).toBe(0);
  });
});
