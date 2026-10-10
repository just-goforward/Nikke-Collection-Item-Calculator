import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { q, toWire } from "../../shared/certifiedRational";
import {
  buildCertifiedSupplySnapshot,
  type CertifiedSupplyEvent,
} from "../../shared/certifiedSupply";
import { WorkBudget } from "./budget";
import { encode } from "./game";
import { FiniteKernel } from "./kernel";
import { solveCertified } from "./solver";
import type { CertifiedInput, CertifiedOutput } from "./types";
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
