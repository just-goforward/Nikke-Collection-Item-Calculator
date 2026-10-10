import { assert, beforeAll, describe, expect, it, vi } from "vitest";
import { q } from "../../shared/certifiedRational";
import { BoundArena } from "./boundArena";
import { WorkBudget } from "./budget";
import { CertainCompletion } from "./completion";
import { CostGuidance } from "./costGuidance";
import { expectation } from "./distribution";
import { law } from "./events";
import { capUnits } from "./game";
import { IntegerFiniteTable } from "./integerTable";
import type { ExactValue } from "./value";

// Exact baseline observations and native-operation invariants; no snapshot
// checkout, source extraction, or ignored workspace is needed by these tests.
const mixedBigInt = "Cannot mix BigInt and other types, use explicit conversions";
const symbolNumeric = "Cannot convert a Symbol value to a number";
const complete: ExactValue = {
  p: q(1),
  b: q(10),
  c: q(10),
  consumed: [q(10), q(0), q(0)],
  mask: 1,
};
let completion: CertainCompletion;
beforeAll(() => {
  completion = new CertainCompletion(new WorkBudget({}, performance.now()));
});

describe("certified optional-coordinate operation boundaries", () => {
  it("preserves sparse stock, NaN and negative-piece division rather than defaulting them", () => {
    expect(capUnits(599, [])).toEqual([NaN, NaN, NaN]);
    expect(capUnits(599, new Array<number>(3))).toEqual([NaN, NaN, NaN]);
    expect(capUnits(599, [10, 20, 30])).toEqual([1, 1, 1]);
    expect(capUnits(599, [-1, 0, NaN])).toEqual([-1, 0, NaN]);
  });

  it("retains native BigInt and Symbol division exceptions", () => {
    expect(() => Reflect.apply(capUnits, undefined, [599, [1n, 0, 0]])).toThrow(
      new TypeError(mixedBigInt),
    );
    expect(() => Reflect.apply(capUnits, undefined, [599, [Symbol("piece"), 0, 0]])).toThrow(
      new TypeError(symbolNumeric),
    );
  });

  it("looks up Math.floor before reading/coercing each raw coordinate", () => {
    const trace: string[] = [];
    const floorDescriptor = Object.getOwnPropertyDescriptor(Math, "floor");
    const minDescriptor = Object.getOwnPropertyDescriptor(Math, "min");
    assert(floorDescriptor);
    assert(minDescriptor);
    const floor = Math.floor;
    const min = Math.min;
    Object.defineProperty(Math, "floor", {
      configurable: true,
      get() {
        trace.push("floor:get");
        return (...args: Parameters<typeof floor>) => {
          trace.push("floor:call");
          return floor(...args);
        };
      },
    });
    Object.defineProperty(Math, "min", {
      configurable: true,
      get() {
        trace.push("min:get");
        return (...args: Parameters<typeof min>) => {
          trace.push("min:call");
          return min(...args);
        };
      },
    });
    let result: unknown;
    try {
      const piece = {
        [Symbol.toPrimitive](hint: string) {
          trace.push(`piece:${hint}`);
          return 10;
        },
      };
      const raw = new Proxy([piece, 0, 0], {
        get(target, key, receiver) {
          trace.push(`raw:${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
      });
      result = Reflect.apply(capUnits, undefined, [599, raw]);
    } finally {
      Object.defineProperty(Math, "floor", floorDescriptor);
      Object.defineProperty(Math, "min", minDescriptor);
    }
    expect(result).toEqual([1, 0, 0]);
    expect(trace).toEqual([
      "min:get",
      "floor:get",
      "raw:0",
      "piece:number",
      "floor:call",
      "min:call",
      "min:get",
      "floor:get",
      "raw:1",
      "floor:call",
      "min:call",
      "min:get",
      "floor:get",
      "raw:2",
      "floor:call",
      "min:call",
    ]);
  });
});

describe("certified completion and relaxation boundaries", () => {
  it("keeps invalid completion lookups false and retains postfix BigInt/Symbol behavior", () => {
    expect(completion.has(-1, [1, 0, 0])).toBe(false);
    expect(completion.has(NaN, [1, 0, 0])).toBe(false);
    expect(Reflect.apply(completion.actionHas, completion, [599, 0, []])).toBe(false);
    expect(Reflect.apply(completion.actionHas, completion, [599, 0, [1n, 0, 0]])).toBe(true);
    expect(() =>
      Reflect.apply(completion.actionHas, completion, [599, 0, [Symbol("unit"), 0, 0]]),
    ).toThrow(new TypeError(symbolNumeric));
    expect(() => completion.actionHas(599, 3, [1, 1, 1])).toThrow(
      new TypeError("undefined is not iterable (cannot read property Symbol(Symbol.iterator))"),
    );
  });

  it("reads the completion address before coercing the available blue count", () => {
    const trace: string[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(completion, "minimumBlue");
    assert(descriptor);
    const minimum = Reflect.get(completion, "minimumBlue");
    Object.defineProperty(completion, "minimumBlue", {
      configurable: true,
      get() {
        trace.push("table:read");
        return new Proxy(minimum, {
          get(target, key) {
            trace.push(`table:${String(key)}`);
            return Reflect.get(target, key, target);
          },
        });
      },
    });
    try {
      const available = {
        [Symbol.toPrimitive](hint: string) {
          trace.push(`available:${hint}`);
          return 1;
        },
      };
      const units = new Proxy([available, 0, 0], {
        get(target, key, receiver) {
          trace.push(`units:${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
      });
      expect(Reflect.apply(completion.has, completion, [599, units])).toBe(true);
    } finally {
      Object.defineProperty(completion, "minimumBlue", descriptor);
    }
    expect(trace).toEqual([
      "units:0",
      "table:read",
      "units:1",
      "units:2",
      "table:2180360",
      "available:number",
    ]);
  });

  it("lets native every visit a fourth entry and skip sparse entries", () => {
    const trace: string[] = [];
    const units = new Proxy([1, 1, 1], {
      get(target, key, receiver) {
        trace.push(`units:${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
    });
    const supports = Reflect.get(CostGuidance.prototype, "supportsRelaxation");
    expect(Reflect.apply(supports, {}, [{ units }, { bound: [0, 0, 0, 0] }])).toBe(false);
    expect(trace).toEqual(["units:0", "units:1", "units:2", "units:3"]);
    trace.length = 0;
    const sparse = new Array<number>(4);
    sparse[3] = 0;
    expect(Reflect.apply(supports, {}, [{ units }, { bound: sparse }])).toBe(false);
    expect(trace).toEqual(["units:3"]);
  });

  it("coerces available then required inside an unbounded every callback", () => {
    const trace: string[] = [];
    const available = {
      [Symbol.toPrimitive](hint: string) {
        trace.push(`available:${hint}`);
        return 10;
      },
    };
    const required = {
      [Symbol.toPrimitive](hint: string) {
        trace.push(`required:${hint}`);
        return 5;
      },
    };
    const supports = Reflect.get(CostGuidance.prototype, "supportsRelaxation");
    expect(Reflect.apply(supports, {}, [{ units: [available, 0, 0] }, { bound: [required] }])).toBe(
      true,
    );
    expect(trace).toEqual(["available:number", "required:number"]);
  });
});

describe("certified distribution, law and storage boundaries", () => {
  it("skips absent zero-prior cohorts but preserves the nonzero-prior rows exception", () => {
    const kernel = { budget: { tick: vi.fn() }, value: vi.fn(() => complete) };
    expect(Reflect.apply(expectation, undefined, [599, [], [q(0), q(0), q(0)], kernel])).toEqual({
      p: q(0),
      b: q(0),
      c: q(0),
      consumed: [q(0), q(0), q(0)],
      mask: 0,
    });
    expect(() =>
      Reflect.apply(expectation, undefined, [599, [], [q(1), q(0), q(0)], kernel]),
    ).toThrow(new TypeError("Cannot read properties of undefined (reading 'rows')"));
    expect(kernel.budget.tick).not.toHaveBeenCalled();
    expect(kernel.value).not.toHaveBeenCalled();
  });

  it("preserves both budget checks before a missing reference's native count exception", () => {
    const trace: string[] = [];
    const refs = new Proxy([], {
      get(target, key, receiver) {
        trace.push(`refs:${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
    });
    const budget = {
      check: () => trace.push("check"),
      setExternalPayload: vi.fn(),
    };
    expect(() =>
      Reflect.apply(law, undefined, [{ snapshot: { laws: [] } }, { refs }, 0, 0, budget]),
    ).toThrow(new TypeError("Cannot read properties of undefined (reading 'count')"));
    expect(trace).toEqual(["check", "refs:0", "check"]);
    expect(budget.setExternalPayload).not.toHaveBeenCalled();
  });

  it("retains support-row method identity and tick/value order for a unit-mass cohort", () => {
    const trace: string[] = [];
    const rows = new Map([["10,0,0", { pieces: [10, 0, 0], mass: q(1) }]]);
    const nativeValues = rows.values;
    Object.defineProperty(rows, "values", {
      get() {
        trace.push("values:get");
        function values(this: typeof rows) {
          trace.push("values:call");
          expect(this).toBe(rows);
          return nativeValues.call(this);
        }
        return values;
      },
    });
    const support = {
      get rows() {
        trace.push("rows");
        return rows;
      },
    };
    const kernel = {
      budget: { tick: vi.fn(() => trace.push("tick")) },
      value: vi.fn(() => {
        trace.push("value");
        return complete;
      }),
    };
    expect(
      Reflect.apply(expectation, undefined, [599, [support], [q(1), q(0), q(0)], kernel]),
    ).toEqual({ ...complete, mask: 0 });
    expect(trace).toEqual(["rows", "values:get", "values:call", "tick", "value"]);
    expect(kernel.value).toHaveBeenCalledExactlyOnceWith(599, [1, 0, 0]);
  });

  it("preserves the short last-page allocation, outward neighbour and status miss", () => {
    const budget = new WorkBudget({}, performance.now());
    const arena = BoundArena.create(599, [1, 1, 1], true, budget);
    assert(arena);
    expect(arena.bytes).toBe(4832);
    expect(arena.get("cost", 599, [1, 1, 1])).toBeNull();
    arena.put("cost", 599, [1, 1, 1], { lo: 1, hi: 1 });
    expect(arena.get("cost", 599, [1, 1, 1])).toEqual({ lo: 1, hi: 1.0000000000000002 });
    expect(arena.bytes).toBe(4976);
    expect(budget.managedPayloadBytes).toBe(4976);
    expect(arena.get("failure", 599, [1, 1, 1])).toBeNull();
    expect(() => arena.get("cost", 599, [2, 0, 0])).toThrow(
      new Error("certified_bound_index_outside_domain"),
    );
  });

  it("retains outward widening if a corrupted payload row is missing", () => {
    const arena = BoundArena.create(599, [1, 1, 1], true, new WorkBudget({}, performance.now()));
    assert(arena);
    Reflect.get(arena, "costPages").set(0, {
      lower: new Float64Array(0),
      width: new Float32Array(0),
      status: Uint8Array.of(1),
    });
    expect(arena.get("cost", 599, [0, 0, 0])).toEqual({ lo: 0, hi: Infinity });
  });

  it("keeps missing integer powers and the subsequent native BigInt exception", () => {
    const table = new IntegerFiniteTable(
      [1n, 1n, 1n],
      new WorkBudget({}, performance.now()),
      () => ({
        value: complete,
        bound: [0, 0, 0],
        actions: [],
      }),
    );
    expect(Reflect.apply(Reflect.get(table, "power"), table, [NaN])).toBeUndefined();
    expect(Reflect.apply(Reflect.get(table, "power"), table, [-1])).toBeUndefined();
    expect(() => Reflect.apply(Reflect.get(table, "fromRelaxed"), table, [complete, NaN])).toThrow(
      new TypeError(mixedBigInt),
    );
  });

  it("reads a lifted rational's divisor, numerator, then divisor again", () => {
    const trace: string[] = [];
    const value: ExactValue = {
      ...complete,
      p: {
        get d() {
          trace.push("d");
          return 1n;
        },
        get n() {
          trace.push("n");
          return 1n;
        },
      },
    };
    const table = new IntegerFiniteTable(
      [1n, 1n, 1n],
      new WorkBudget({}, performance.now()),
      () => ({
        value: complete,
        bound: [0, 0, 0],
        actions: [],
      }),
    );
    expect(Reflect.apply(Reflect.get(table, "fromRelaxed"), table, [value, 0])).toEqual({
      p: 1n,
      consumed: [10n, 0n, 0n],
      exponent: 0,
      mask: 1,
    });
    expect(trace).toEqual(["d", "n", "d"]);
  });
});
