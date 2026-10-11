import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ONE, type Q, q, sub, sum, toWire, ZERO } from "../../shared/certifiedRational";
import {
  buildCertifiedSupplySnapshot,
  type CertifiedSupplyEvent,
} from "../../shared/certifiedSupply";
import { WorkBudget } from "./budget";
import { encode } from "./game";
import { FiniteKernel } from "./kernel";
import { solveCertified } from "./solver";
import type { CertifiedInput, CertifiedOutput, CertifiedValue } from "./types";
import { loadCertifiedWasm, WasmKernel } from "./wasmBackend";
import { solveCertifiedWasm } from "./wasmSolver";

const AS_OF = "2026-09-30T08:00:00.000Z";
let module: WebAssembly.Module;
beforeAll(async () => {
  module = await loadCertifiedWasm(() => readFile("public/certified_solver.wasm"));
});
function event(day: number, lawId: string): CertifiedSupplyEvent {
  const gameDate = new Date(Date.parse("2026-09-30T00:00:00Z") + day * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    id: `dispatch:${gameDate}`,
    gameDate,
    at: `${gameDate}T08:00:00.000Z`,
    kind: "dispatch",
    status: "confirmed",
    refs: [{ lawId, count: 1 }],
    ruleId: "test-rule",
  };
}
function fixture(events: CertifiedSupplyEvent[] = [], zeroRate = false): CertifiedInput {
  const snapshot = structuredClone(
    buildCertifiedSupplySnapshot({
      asOf: AS_OF,
      revision: "wasm-parity-v1",
      sourceHash: "a".repeat(64),
      soloPeriods: [],
      collaborationPeriods: [],
      sourceStatus: "healthy",
    }),
  );
  snapshot.events = events;
  snapshot.rules = [
    {
      id: "test-rule",
      effectiveFrom: "2020-01-01T00:00:00Z",
      effectiveUntil: null,
      dispatch: [{ lawId: zeroRate ? "deterministic:0,0,0" : "deterministic:1,1,1", count: 1 }],
      normalShop: [],
      collaborationShop: [],
      soloDays: [],
      provenance: ["exact fixture"],
    },
  ];
  return { grade: "SR", level: 14, exp: 0, stock: [0, 0, 0], asOf: AS_OF, snapshot };
}
function behavior(result: CertifiedOutput) {
  return {
    status: result.status,
    current: result.current,
    waiting: result.waiting,
    refusal: result.refusal,
    pricing: result.pricing,
    claimNotice: result.claimNotice,
  };
}
function parity(input: CertifiedInput) {
  const expected = solveCertified(input);
  const actual = solveCertifiedWasm(module, input);
  expect(behavior(actual)).toEqual(behavior(expected));
  expect(actual.diagnostics.wasmMemoryBytes).toBeGreaterThan(0);
  expect(actual.provenance.solverVersion).toBe("certified-exact-rust-wasm-v1");
  return actual;
}
describe("real Rust/WASM certified computation", () => {
  it.each([
    "regular-box-v1",
    "box-ii-v1",
    "dispatch-board-v1",
    "deterministic:1,2,3",
    "deterministic:custom",
    "custom",
  ])("prices explicit finite %s in the direct kernel without a JS result oracle", (id) => {
    const input = fixture();
    input.priceBasisStock = [1, 1, 1];
    input.snapshot.laws = [
      {
        id,
        kind: "finite",
        modelVersion: "fixture-v1",
        outcomes: [{ pieces: [99, 0, 0], mass: toWire(q(1)) }],
      },
    ];
    input.snapshot.rules = input.snapshot.rules.map((rule) => ({
      ...rule,
      dispatch: [{ lawId: id, count: 1 }],
    }));
    const kernel = new WasmKernel(module, new WorkBudget({}, performance.now()));
    try {
      expect(kernel.prepare(input, encode("SR", 14, 0), [q(1, 3), q(1, 3), q(1, 3)])).toEqual({
        basisStock: [1, 1, 1],
        recurringRate: [toWire(q(99)), toWire(q(0)), toWire(q(0))],
        weights: [toWire(q(1, 100)), toWire(q(1)), toWire(q(1))],
        cohortWeights: [toWire(q(1, 3)), toWire(q(1, 3)), toWire(q(1, 3))],
      });
    } finally {
      kernel.dispose();
    }
  });

  it("rejects substituted artifacts before instantiation and imports no host math", async () => {
    const bytes = await readFile("public/certified_solver.wasm");
    const last = bytes.at(-1);
    if (last === undefined) throw new Error("empty WASM fixture");
    bytes[bytes.length - 1] = last ^ 1;
    await expect(loadCertifiedWasm(async () => bytes)).rejects.toThrow(
      "certified_wasm_hash_mismatch",
    );
    expect(WebAssembly.Module.imports(module)).toEqual([
      { module: "certified", name: "now_ms", kind: "function" },
    ]);
  });
  it("matches exact P/B/C, consumption vectors, root ties and normal-prefix batching", () => {
    const weights = [q(1, 97), q(1, 43), q(1, 29)] as const;
    const oracle = new FiniteKernel(weights, new WorkBudget({}, performance.now()));
    const rust = new WasmKernel(module, new WorkBudget({}, performance.now()));
    rust.initialize(weights);
    for (const grade of ["R", "SR"] as const) {
      for (const level of [0, 5, 10, 14, 15]) {
        for (const stock of [
          [0, 0, 0],
          [20, 10, 10],
          [10, 20, 30],
          [49, 31, 20],
        ] as const) {
          const sid = encode(grade, level, 0);
          expect(rust.actualValue(rust.solve(sid, stock))).toEqual(
            oracle.actualValue(oracle.solve(sid, stock)),
          );
        }
      }
    }
    rust.dispose();
    parity({ ...fixture(), stock: [30, 20, 10], batchLimit: 3, priceBasisStock: [300, 50, 20] });
    parity({ ...fixture(), exp: 2900, stock: [10, 10, 10] });
  });
  it("keeps fixed pricing, earliest day, H56 witness, completion, claims and source uncertainty", () => {
    expect(parity(fixture([event(1, "deterministic:0,0,10")])).waiting.recommendedDays).toBe(1);
    expect(parity(fixture([event(56, "deterministic:0,0,10")])).waiting.recommendedDays).toBe(56);
    parity({ ...fixture([event(0, "deterministic:10,0,0")], true), level: 15 });
    parity(fixture([event(1, "deterministic:0,0,10")], true));
    const uncertain = fixture([event(1, "deterministic:0,0,10")]);
    uncertain.snapshot.sourceStatus = "uncertain";
    parity(uncertain);
    const incomplete = fixture();
    incomplete.snapshot.coverage.future.complete = false;
    incomplete.snapshot.coverage.future.missing = ["not_covered"];
    parity(incomplete);
    parity({ ...incomplete, exp: 2900, stock: [10, 0, 0] });
  });
  it("performs conditional cohort convolution and expectations in Rust; preserves partial on support refusal", () => {
    const input = fixture([event(1, "cohort-test"), event(2, "cohort-test")]);
    input.snapshot.laws = [
      {
        id: "cohort-test",
        kind: "finite",
        modelVersion: "test-v1",
        outcomesByCohort: [
          [{ pieces: [0, 0, 5], mass: toWire(q(1)) }],
          [{ pieces: [5, 0, 0], mass: toWire(q(1)) }],
          [{ pieces: [0, 0, 0], mass: toWire(q(1)) }],
        ],
      },
    ];
    input.cohortWeights = [toWire(q(1, 2)), toWire(q(1, 2)), toWire(q(0))];
    expect(parity(input).waiting.value?.successP).toEqual(toWire(q(11, 20)));
    input.snapshot.laws = [
      {
        id: "cohort-test",
        kind: "finite",
        modelVersion: "test-v1",
        outcomes: [
          { pieces: [0, 0, 0], mass: toWire(q(1, 2)) },
          { pieces: [0, 0, 10], mass: toWire(q(1, 2)) },
        ],
      },
    ];
    let partial: CertifiedOutput | undefined;
    const options = {
      maxSupportPoints: 1,
      onCurrent: (output: CertifiedOutput) => {
        partial = output;
      },
    };
    const actual = solveCertifiedWasm(module, input, options);
    expect(partial?.current).not.toBeNull();
    expect(behavior(actual)).toEqual(behavior(solveCertified(input, options)));
    expect(actual.waiting.reason).toBe("exact_support_limit");
  });
  it("bounds deadlines and memory without a JS fallback", () => {
    expect(
      solveCertifiedWasm(module, fixture(), { deadlineAt: performance.now() - 1 }).refusal?.reason,
    ).toBe("request_budget_exhausted");
    expect(
      solveCertifiedWasm(module, fixture(), { maxManagedPayloadBytes: 1024 }).refusal?.reason,
    ).toBe("managed_payload_ceiling");
    const input = { ...fixture(), level: 10, stock: [20, 20, 20] as const };
    const refused = solveCertifiedWasm(module, input, { maxMemoEntries: 1 });
    expect(refused.refusal?.reason).toBe("exact_memo_limit");
  });
  it("matches JS waiting failure output after a post-current deadline", () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const options = {
      deadlineAt: 1000,
      onCurrent: () => {
        now = 2000;
      },
    };
    try {
      const input = fixture();
      const expected = solveCertified(input, options);
      now = 0;
      const actual = solveCertifiedWasm(module, input, options);
      expect(expected.refusal).toEqual({ reason: "request_budget_exhausted", phase: "waiting" });
      expect(expected.current).not.toBeNull();
      expect(behavior(actual)).toEqual(behavior(expected));
    } finally {
      clock.mockRestore();
    }
  });
  it("keeps safe-integer raw arrivals without u32 truncation and observes fixed price basis", () => {
    parity(fixture([event(1, "deterministic:4294967296,0,0")]));
    const input = {
      ...fixture([event(1, "deterministic:0,0,10")]),
      priceBasisStock: [100, 200, 300] as const,
    };
    parity(input);
  });
});

// Hand-derived oracle for the default fixture state SR14 exp0 (no JS/WASM output is an
// expectation). Caps are [15, 6, 1] uses = [150, 60, 10] physical pieces; great per mille is
// blue 100, purple 450, yellow 1000 and blue/purple normals (+200/+500 exp) stay at level 14.
// priceBasisStock 0 with the fixture's recurring dispatch 1,1,1 fixes every weight to 1, so
// B = C = sum(consumed pieces). Endpoint values by capped whole-use units (blue,purple,yellow):
//   V(0,0,0) = P 0, consumed 0.
//   V(1,0,0) = P 1/10, consumed [10,0,0].
//   V(2,0,0) = P 1 - (9/10)^2 = 19/100, consumed [10 + 9, 0, 0].
//   V(1,1,0): both orders give P = 1/10 + 9/10*45/100 = 45/100 + 55/100*1/10 = 101/200;
//     purple first has B = 10 + 55/100*10 = 31/2 < 19, so consumed [11/2, 10, 0].
//   V(b,p,1) = P 1, consumed [0,0,10] (the only P=1 policy costing exactly one use).
type Row = readonly [blue: number, purple: number, yellow: number, n: number, d: number];
type Exact = readonly [Q, Q, Q];
const ALL_DAYS = Array.from({ length: 57 }, (_, day) => day);
const rows = (list: readonly Row[]) =>
  list.map(([blue, purple, yellow, n, d]) => ({
    pieces: [blue, purple, yellow] as [number, number, number],
    mass: toWire(q(n, d)),
  }));
function grouped(
  events: CertifiedSupplyEvent[],
  laws: CertifiedInput["snapshot"]["laws"],
  stock: CertifiedInput["stock"] = [0, 0, 0],
): CertifiedInput {
  const input = { ...fixture(events), stock, priceBasisStock: [0, 0, 0] as const };
  input.snapshot.laws = laws;
  return input;
}
function expectValue(value: CertifiedValue | null | undefined, p: Q, consumed: Exact) {
  const total = sum(consumed);
  expect(
    value && {
      successP: value.successP,
      weightedExpectedConsumptionB: value.weightedExpectedConsumptionB,
      expectedTotalConsumptionC: value.expectedTotalConsumptionC,
      expectedConsumed: value.expectedConsumed,
    },
  ).toEqual({
    successP: toWire(p),
    weightedExpectedConsumptionB: toWire(total),
    expectedTotalConsumptionC: toWire(total),
    expectedConsumed: consumed.map(toWire),
  });
}
function expectCertifiedDay(result: CertifiedOutput, day: number, p: Q, consumed: Exact) {
  expect({
    status: result.status,
    refusal: result.refusal,
    weights: result.pricing?.weights,
  }).toEqual({ status: "completed", refusal: null, weights: [ONE, ONE, ONE].map(toWire) });
  const { waiting } = result;
  expect({
    status: waiting.status,
    reason: waiting.reason,
    recommendedDays: waiting.recommendedDays,
    bestDayRange: waiting.bestDayRange,
    rangeBoundary: waiting.rangeBoundary,
    evaluatedDays: waiting.evaluatedDays,
    interval: waiting.successProbabilityInterval,
    gap: waiting.successImprovementUpperBound,
  }).toEqual({
    status: "certified",
    reason: null,
    recommendedDays: day,
    bestDayRange: [day, day],
    rangeBoundary: false,
    evaluatedDays: ALL_DAYS,
    interval: { lower: toWire(p), upper: toWire(p) },
    gap: toWire(sub(ONE, p)),
  });
  expect(waiting.evidence).toContain("exact_rational_all_57_date_expectations");
  expectValue(waiting.value, p, consumed);
}
describe("Rust/WASM exact date expectations over physical supports", () => {
  it("groups distinct physical pieces by all capped units and keeps remainders for the next event", () => {
    // Stock [10,0,0]. Day 1 adds purple 0/10/14/6 or yellow 10; 10 and 14 purple are both one
    // purple use (cap 60 pieces, not premerged), 0 and 6 are zero uses. Day 2 adds 4 purple:
    // 6 -> 10 crosses into a use, 14 -> 18 stays one use, 0 -> 4 stays zero uses.
    const laws: CertifiedInput["snapshot"]["laws"] = [
      {
        id: "mixed-remainders",
        kind: "finite",
        modelVersion: "grouping-v1",
        outcomes: rows([
          [0, 0, 0, 1, 4],
          [0, 10, 0, 1, 8],
          [0, 14, 0, 1, 8],
          [0, 0, 10, 1, 4],
          [0, 6, 0, 1, 4],
        ]),
      },
    ];
    const first = solveCertifiedWasm(
      module,
      grouped([event(1, "mixed-remainders")], laws, [10, 0, 0]),
    );
    expect(first.current).toMatchObject({
      status: "use_certified",
      kit: "blue",
      optimalActionMask: 1,
      uses: 1,
      pieces: 10,
    });
    expectValue(first.current?.value, q(1, 10), [q(10), ZERO, ZERO]);
    // Day 1 units: (1,0,0) mass 1/2, (1,1,0) mass 1/4, (1,0,1) mass 1/4.
    // P = 1/2*1/10 + 1/4*101/200 + 1/4 = 341/800; blue 5 + 11/8; purple 5/2; yellow 5/2.
    expectCertifiedDay(first, 1, q(341, 800), [q(51, 8), q(5, 2), q(5, 2)]);
    const second = solveCertifiedWasm(
      module,
      grouped([event(1, "mixed-remainders"), event(2, "deterministic:0,4,0")], laws, [10, 0, 0]),
    );
    // Day 2 units: (1,0,0) mass 1/4, (1,1,0) mass 1/8+1/8+1/4 = 1/2, (1,0,1) mass 1/4.
    // P = 1/40 + 101/400 + 1/4 = 211/400; blue 5/2 + 11/4 = 21/4; purple 5; yellow 5/2.
    // Flooring day-1 supports to whole uses would leave (1,0,0) at mass 1/2 instead.
    expectCertifiedDay(second, 2, q(211, 400), [q(21, 4), q(5), q(5, 2)]);
    expect(second.diagnostics.supportPeakPoints).toBe(5);
  });
  it("keeps each positive-prior latent cohort's own law and skips a zero-prior cohort", () => {
    // Priors [1/2, 0, 1/2]. Cohort 0 always +5 blue; cohort 1 (zero prior) has three purple
    // points that would exceed maxSupportPoints 3 after two events; cohort 2 is 0 or +10 blue.
    const laws: CertifiedInput["snapshot"]["laws"] = [
      {
        id: "latent",
        kind: "finite",
        modelVersion: "grouping-v1",
        outcomesByCohort: [
          rows([[5, 0, 0, 1, 1]]),
          rows([
            [0, 1, 0, 1, 3],
            [0, 2, 0, 1, 3],
            [0, 3, 0, 1, 3],
          ]),
          rows([
            [0, 0, 0, 1, 2],
            [10, 0, 0, 1, 2],
          ]),
        ],
      },
    ];
    const priors = [toWire(q(1, 2)), toWire(ZERO), toWire(q(1, 2))] as const;
    const options = { maxSupportPoints: 3 };
    const first = solveCertifiedWasm(
      module,
      { ...grouped([event(1, "latent")], laws), cohortWeights: priors },
      options,
    );
    expect(first.current).toMatchObject({ status: "preserve", kit: null, optimalActionMask: 0 });
    expect(first.pricing?.cohortWeights).toEqual(priors);
    // Day 1: cohort 0 at 5 pieces = V(0,0,0); cohort 2 at 0/10 -> P 1/20, blue 5.
    expectCertifiedDay(first, 1, q(1, 40), [q(5, 2), ZERO, ZERO]);
    expect(first.diagnostics.supportPeakPoints).toBe(2);
    const second = solveCertifiedWasm(
      module,
      { ...grouped([event(1, "latent"), event(2, "latent")], laws), cohortWeights: priors },
      options,
    );
    // Day 2: cohort 0 at 10 -> V(1,0,0); cohort 2 at 0/10/20 with 1/4,1/2,1/4 ->
    // P 1/20 + 19/400 = 39/400, blue 5 + 19/4 = 39/4. Mixed: P 79/800, blue 79/8.
    // A prior-averaged per-event law would give P 119/1600 instead.
    expectCertifiedDay(second, 2, q(79, 800), [q(79, 8), ZERO, ZERO]);
    expect(second.diagnostics.supportPeakPoints).toBe(3);
  });
  it("clamps physical pieces to state caps before counting support points", () => {
    // Blue 150/155/170 clamp to cap 150 and yellow 10/11/12 clamp to cap 10: one physical point.
    const laws: CertifiedInput["snapshot"]["laws"] = [
      {
        id: "over-cap",
        kind: "finite",
        modelVersion: "grouping-v1",
        outcomes: rows([
          [150, 0, 10, 1, 3],
          [155, 0, 11, 1, 3],
          [170, 0, 12, 1, 3],
        ]),
      },
    ];
    const result = solveCertifiedWasm(module, grouped([event(1, "over-cap")], laws), {
      maxSupportPoints: 1,
    });
    // Capped units (15,0,1): V = P 1 with one yellow use.
    expectCertifiedDay(result, 1, ONE, [ZERO, ZERO, q(10)]);
    expect(result.diagnostics.supportPeakPoints).toBe(1);
  });
  it("enforces the physical support limit even when every point maps to one whole use", () => {
    // Day 1: blue 10..13 (four points, one blue use). Day 2: +0/+1 blue -> 10..14 (five points,
    // masses 1/8,1/4,1/4,1/4,1/8, all one blue use) so every completed date equals V(1,0,0).
    const laws: CertifiedInput["snapshot"]["laws"] = [
      {
        id: "spread",
        kind: "finite",
        modelVersion: "grouping-v1",
        outcomes: rows([
          [10, 0, 0, 1, 4],
          [11, 0, 0, 1, 4],
          [12, 0, 0, 1, 4],
          [13, 0, 0, 1, 4],
        ]),
      },
      {
        id: "coin",
        kind: "finite",
        modelVersion: "grouping-v1",
        outcomes: rows([
          [0, 0, 0, 1, 2],
          [1, 0, 0, 1, 2],
        ]),
      },
    ];
    const first = solveCertifiedWasm(module, grouped([event(1, "spread")], laws), {
      maxSupportPoints: 4,
    });
    expectCertifiedDay(first, 1, q(1, 10), [q(10), ZERO, ZERO]);
    expect(first.diagnostics.supportPeakPoints).toBe(4);
    const both = grouped([event(1, "spread"), event(2, "coin")], laws);
    const refused = solveCertifiedWasm(module, both, { maxSupportPoints: 4 });
    expect(refused.status).toBe("partial");
    expect(refused.refusal).toEqual({ reason: "exact_support_limit", phase: "waiting" });
    expect(refused.current).toMatchObject({ status: "preserve", optimalActionMask: 0 });
    expect(refused.waiting).toMatchObject({
      status: "unresolved",
      reason: "exact_support_limit",
      recommendedDays: null,
      value: null,
      bestDayRange: [0, 56],
      evaluatedDays: [0, 1],
      successProbabilityInterval: { lower: toWire(q(1, 10)), upper: toWire(ONE) },
      successImprovementUpperBound: toWire(q(9, 10)),
    });
    const allowed = solveCertifiedWasm(module, both, { maxSupportPoints: 5 });
    expectCertifiedDay(allowed, 1, q(1, 10), [q(10), ZERO, ZERO]);
    expect(allowed.diagnostics.supportPeakPoints).toBe(5);
  });
});

describe("Rust/WASM execution limits", () => {
  it("never releases or reuses an instance after a RangeError escapes either WASM entry", async () => {
    const bytes = await readFile("public/certified_solver.wasm");
    for (const entry of ["certified_input", "certified_call"] as const) {
      const isolatedModule = new WebAssembly.Module(bytes);
      const release = vi.fn();
      // WebAssembly.Instance is called with new; an arrow implementation is not constructable.
      function createInstance(): WebAssembly.Instance {
        return {
          exports: {
            memory: new WebAssembly.Memory({ initial: 2 }),
            certified_abi_version: () => 1,
            certified_reset_heap_peak: () => {},
            certified_heap_peak: () => 0,
            certified_heap_limit: () => {},
            certified_input: () => 8,
            certified_call: () => {},
            certified_release: release,
            [entry]: () => {
              throw new RangeError("simulated WASM stack exhaustion");
            },
          },
        };
      }
      const instance = vi.spyOn(WebAssembly, "Instance").mockImplementation(createInstance);
      try {
        const broken = new WasmKernel(isolatedModule, new WorkBudget({}, performance.now()));
        let thrown: unknown;
        try {
          broken.initialize([q(1), q(1), q(1)]);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(RangeError);
        expect(thrown).toHaveProperty("message", "simulated WASM stack exhaustion");
        expect(instance.mock.results[0]?.value.exports).toBe(broken.exports);
        broken.dispose();
        expect(release).not.toHaveBeenCalled();
        const replacement = new WasmKernel(isolatedModule, new WorkBudget({}, performance.now()));
        expect(replacement.exports).not.toBe(broken.exports);
        expect(instance.mock.results[1]?.value.exports).toBe(replacement.exports);
        expect(instance).toHaveBeenCalledTimes(2);
        replacement.dispose();
        expect(release).toHaveBeenCalledTimes(1);
      } finally {
        instance.mockRestore();
      }
    }
  });
  it("checks deadlines inside Rust and discards an allocator-trapped instance", () => {
    const input = {
      ...fixture(),
      grade: "R" as const,
      level: 0,
      stock: [300, 200, 100] as const,
      computeWaiting: false,
    };
    const timed = solveCertifiedWasm(module, input, { deadlineAt: performance.now() + 25 });
    expect(timed.refusal?.reason).toBe("request_budget_exhausted");
    expect(timed.current).toBeNull();
    const limited = solveCertifiedWasm(module, input, { maxManagedPayloadBytes: 1024 * 1024 });
    expect(limited.refusal?.reason).toBe("managed_payload_ceiling");
    expect(limited.current).toBeNull();
    expect(parity({ ...fixture(), exp: 2900, stock: [10, 0, 0] }).current?.value.successP).toEqual(
      toWire(q(1)),
    );
  });
  it("bounded representative exact comparison: SR10 and physical R0 including waiting", () => {
    const physical = buildCertifiedSupplySnapshot({
      asOf: AS_OF,
      revision: "physical-wasm-parity",
      sourceHash: "a".repeat(64),
      soloPeriods: [],
      collaborationPeriods: [],
    });
    const inputs: CertifiedInput[] = [
      { ...fixture(), level: 10, stock: [100, 30, 20] },
      {
        grade: "R",
        level: 0,
        exp: 0,
        stock: [300, 50, 20],
        asOf: AS_OF,
        snapshot: physical,
        receivedEventIds: physical.events
          .filter((e) => e.gameDate === physical.coverage.currentDay)
          .map((e) => e.id),
      },
      {
        grade: "R",
        level: 0,
        exp: 0,
        stock: [300, 200, 100],
        asOf: AS_OF,
        snapshot: physical,
        receivedEventIds: physical.events
          .filter((e) => e.gameDate === physical.coverage.currentDay)
          .map((e) => e.id),
      },
      {
        grade: "SR",
        level: 0,
        exp: 0,
        stock: [800, 200, 100],
        asOf: AS_OF,
        snapshot: physical,
        receivedEventIds: physical.events
          .filter((e) => e.gameDate === physical.coverage.currentDay)
          .map((e) => e.id),
      },
    ];
    for (const input of inputs) {
      const expected = solveCertified(input, { maxManagedPayloadBytes: 160 * 1024 * 1024 });
      const actual = solveCertifiedWasm(module, input, {
        maxManagedPayloadBytes: 160 * 1024 * 1024,
      });
      console.info(
        JSON.stringify({
          case: `${input.grade}${input.level}:${input.stock.join(",")}`,
          jsMs: expected.diagnostics.elapsedMs,
          wasmMs: actual.diagnostics.elapsedMs,
          jsStatus: expected.status,
          wasmStatus: actual.status,
          refusal: actual.refusal,
          wasmMemo: actual.diagnostics.memoEntries,
          wasmMemoryBytes: actual.diagnostics.wasmMemoryBytes,
        }),
      );
      expect(behavior(actual)).toEqual(behavior(expected));
    }
  }, 90_000);
});
