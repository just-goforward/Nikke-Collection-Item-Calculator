import { describe, expect, it } from "vitest";
import type { CertifiedValue } from "../src/certified/types.ts";
import { type OracleInput, q, wire } from "./certified-staging-oracle.ts";
import { independentLayeredOracle } from "./certified-staging-oracle-layered.ts";
import { evaluatePublicLayeredFeasibility } from "./certified-staging-oracle-public-layered-feasibility.ts";
import { evaluatePublicLayeredRelaxationPair } from "./certified-staging-oracle-public-layered-relaxation.ts";
import { evaluatePublicPathRelaxationPair } from "./certified-staging-oracle-public-path-relaxation.ts";
import { checkPublicRelaxationProof } from "./certified-staging-oracle-relaxation-proof.ts";

function request() {
  return {
    grade: "SR" as const,
    level: 14,
    exp: 2400,
    prices: [q(1), q(2), q(4)] as const,
    stock: [40, 20, 20] as const,
    beforeStock: [0, 40, 40] as const,
    afterStock: [10, 40, 40] as const,
    finiteColors: [0, 2] as const,
  };
}
const beforeValue = {
  P: q(1),
  B: q(31),
  C: q(31, 2),
  consumed: [q(0), q(31, 2), q(0)],
  mask: 2,
  chosen: 1,
};
const afterValue = {
  P: q(1),
  B: q(51, 2),
  C: q(31, 2),
  consumed: [q(11, 2), q(10), q(0)],
  mask: 2,
  chosen: 1,
};
function saved(
  endpoint: NonNullable<ReturnType<typeof evaluatePublicPathRelaxationPair>["before"]>,
): CertifiedValue {
  return {
    successP: wire(endpoint.P),
    weightedExpectedConsumptionB: wire(endpoint.B),
    expectedTotalConsumptionC: wire(endpoint.C),
    expectedConsumed: [
      wire(endpoint.consumed[0]),
      wire(endpoint.consumed[1]),
      wire(endpoint.consumed[2]),
    ],
    display: { successP: 1, weightedExpectedConsumptionB: 0, expectedTotalConsumptionC: 0 },
  };
}

describe("layered non-null tuple and callback contracts", () => {
  it("preserves public DAG and denominator domains over every admissible state", () => {
    let checked = 0;
    for (const grade of ["R", "SR"] as const)
      for (let level = 0; level <= 15; level++) {
        let maximumExp = grade === "R" ? 1000 : 3000;
        if (level === 15) maximumExp = 100;
        for (let exp = 0; exp < maximumExp; exp += 100) {
          const input = {
            ...request(),
            grade,
            level,
            exp,
            stock: [10_000, 10_000, 10_000] as const,
            beforeStock: [10_000, 10_000, 10_000] as const,
            afterStock: [10_000, 10_000, 10_000] as const,
            finiteColors: [] as const,
          };
          const feasible = evaluatePublicLayeredFeasibility(input);
          const layered = evaluatePublicLayeredRelaxationPair(input);
          const path = evaluatePublicPathRelaxationPair(input);
          const values = [feasible.value, layered.before, path.before];
          const plans = [feasible.plan, layered.plan, path.plan];
          expect([feasible.status, layered.status]).toEqual(["PASS", "PASS"]);
          for (const plan of plans) {
            if (!plan) throw new Error("Missing boundary plan");
            expect(Number.isSafeInteger(plan.rootDepth) && plan.rootDepth >= 0).toBe(true);
            expect(plan.finiteWidths).toEqual([1, 1, 1]);
            expect(plan.widthProduct).toBe(1);
          }
          const reference = feasible.value;
          if (!reference) throw new Error("Missing feasible boundary value");
          for (const value of values) {
            if (!value) throw new Error("Missing boundary endpoint");
            expect(value.P).toEqual(q(1));
            expect([value.B, value.C, value.consumed, value.mask, value.chosen]).toEqual([
              reference.B,
              reference.C,
              reference.consumed,
              reference.mask,
              reference.chosen,
            ]);
            expect(value.chosen === -1 || (value.mask & (1 << value.chosen)) !== 0).toBe(true);
          }
          checked++;
        }
      }
    expect(checked).toBe(15 * (1000 / 100 + 3000 / 100) + 2);
  }, 30_000);

  it("preserves exact three-color ties and check callback order", () => {
    const checks: Array<readonly [number, number | undefined]> = [];
    const input: OracleInput = {
      ...request(),
      exp: 2900,
      prices: [q(1), q(1), q(1)],
      stock: [10, 10, 10],
    };
    expect(
      independentLayeredOracle(input, {
        maxMemoEntries: 50_000,
        check(live, cumulative) {
          checks.push([live, cumulative]);
        },
      }),
    ).toEqual({
      P: q(1),
      B: q(10),
      C: q(10),
      consumed: [q(10), q(0), q(0)],
      action: "blue",
      ties: ["blue", "purple", "yellow"],
      candidates: new Map(),
      nodes: 7,
    });
    expect(checks).toEqual([
      [0, 1],
      [1, 7],
    ]);
    expect(() =>
      independentLayeredOracle(input, {
        maxMemoEntries: 50_000,
        check() {
          throw new RangeError("callback boundary");
        },
      }),
    ).toThrow(new RangeError("callback boundary"));
    expect(() =>
      independentLayeredOracle(input, {
        maxMemoEntries: 0,
        check() {},
      }),
    ).toThrow("independent_layered_state_box_admission_limit");
  });

  it("preserves layered malformed price errors without adding validation", () => {
    const prices: [ReturnType<typeof q>, ReturnType<typeof q>, ReturnType<typeof q>] = [
      q(1),
      q(2),
      q(4),
    ];
    Reflect.deleteProperty(prices, "1");
    expect(() =>
      independentLayeredOracle(
        { ...request(), prices },
        {
          maxMemoEntries: 50_000,
          check() {},
        },
      ),
    ).toThrow(new TypeError("Cannot read properties of undefined (reading 'n')"));
    prices[1] = { n: 1n, d: 0n };
    expect(() =>
      independentLayeredOracle(
        { ...request(), prices },
        {
          maxMemoEntries: 50_000,
          check() {},
        },
      ),
    ).toThrow(new RangeError("Division by zero"));
  });
});

describe("layered exact endpoints and malformed coordinates", () => {
  it("preserves exact public P/B/C, consumption, masks, chosen actions and worst uses", () => {
    const feasible = evaluatePublicLayeredFeasibility(request());
    expect(feasible.status).toBe("PASS");
    expect(feasible.value).toEqual({ ...afterValue, worstAll: [1, 1, 0] });
    const layered = evaluatePublicLayeredRelaxationPair(request());
    expect(layered.status).toBe("PASS");
    expect(layered.before).toEqual(beforeValue);
    expect(layered.after).toEqual(afterValue);
    expect(layered.strictOrder).toBe(1);
    const path = evaluatePublicPathRelaxationPair(request());
    expect(path.status).toBe("PASS_ENDPOINTS_EQUALITY");
    expect(path.before).toEqual({ ...beforeValue, worst: [0, 2, 0] });
    expect(path.after).toEqual({ ...afterValue, worst: [1, 1, 0] });
    expect([path.beforeFits, path.afterFits, path.strictOrder]).toEqual([true, true, 1]);
  });

  it("preserves the path table's sparse unlimited stock acceptance and NaN refusal", () => {
    const beforeStock: [number, number, number] = [0, 40, 40];
    Reflect.deleteProperty(beforeStock, "1");
    const sparse = evaluatePublicPathRelaxationPair({ ...request(), beforeStock });
    expect(sparse.status).toBe("PASS_N_ONLY");
    expect(sparse.before).toEqual({ ...beforeValue, worst: [0, 2, 0] });
    expect([sparse.beforeFits, sparse.afterFits]).toEqual([false, true]);
    beforeStock[1] = Number.NaN;
    const invalid = evaluatePublicPathRelaxationPair({ ...request(), beforeStock });
    expect(invalid.status).toBe("NOTRUN");
    expect(invalid.reason).toBe("independent_public_relaxation_invalid_stock");
    expect(invalid.rawException?.name).toBe("Error");
  });

  it("keeps public sparse price behavior distinct between strict and permissive validators", () => {
    const prices: [ReturnType<typeof q>, ReturnType<typeof q>, ReturnType<typeof q>] = [
      q(1),
      q(2),
      q(4),
    ];
    Reflect.deleteProperty(prices, "1");
    const input = { ...request(), prices };
    const feasible = evaluatePublicLayeredFeasibility(input);
    const layered = evaluatePublicLayeredRelaxationPair(input);
    const path = evaluatePublicPathRelaxationPair(input);
    expect(feasible.reason).toBe("public_feasibility_invalid_prices");
    expect(layered.reason).toBe("public_layered_invalid_prices");
    expect(path.reason).toBe("Cannot read properties of undefined (reading 'n')");
    expect(path.rawException?.name).toBe("TypeError");
    if (!path.plan) throw new Error("Sparse price failure must preserve its completed plan");
    expect(Number.isNaN(path.plan.maximumRowBytes)).toBe(true);
    expect(Number.isNaN(path.plan.admittedLogicalUpperBytes)).toBe(true);
    expect(Number.isNaN(path.plan.limbBasis.integralPriceBits[1])).toBe(true);
    expect([feasible.status, layered.status, path.status]).toEqual(["NOTRUN", "NOTRUN", "NOTRUN"]);
  });

  it("preserves addition-before-denominator access for custom native price map results", () => {
    const events: string[] = [];
    const numeratorBits = [
      {
        [Symbol.toPrimitive](hint: string) {
          events.push(`coerce:${hint}`);
          return 1;
        },
      },
      1,
      1,
    ];
    const denominatorBits = [1, 1, 1];
    Object.defineProperty(denominatorBits, "0", {
      get() {
        events.push("denominator");
        return 1;
      },
    });
    const prices = [q(1), q(2), q(4)] as const;
    let maps = 0;
    Object.defineProperty(prices, "map", {
      value() {
        return ++maps === 1 ? numeratorBits : denominatorBits;
      },
    });
    const result = evaluatePublicPathRelaxationPair({ ...request(), prices });
    // scaleBits' reduce reads the denominator first; coordinate addition
    // must then coerce the numerator before its denominator getter is read.
    expect(events.slice(0, 3)).toEqual(["denominator", "coerce:default", "denominator"]);
    expect(result.status).toBe("PASS_ENDPOINTS_EQUALITY");
    expect(result.before).toEqual({ ...beforeValue, worst: [0, 2, 0] });
    expect(result.after).toEqual({ ...afterValue, worst: [1, 1, 0] });
  });
});

describe("layered admission and proof boundaries", () => {
  it("preserves admission boundaries and terminal selected actions", () => {
    const rows = evaluatePublicPathRelaxationPair(request(), { maxRows: 1 });
    expect(rows.reason).toBe("independent_public_relaxation_row_admission");
    const bytes = evaluatePublicPathRelaxationPair(request(), { maxLogicalBytes: 1 });
    expect(bytes.reason).toBe("independent_public_relaxation_graph_admission");
    expect([rows.status, bytes.status]).toEqual(["NOTRUN", "NOTRUN"]);
    const terminal = evaluatePublicPathRelaxationPair({ ...request(), level: 15, exp: 0 });
    expect(terminal.status).toBe("UNKNOWN");
    expect(terminal.reason).toBe("independent_public_relaxation_no_strict_improvement");
    expect(terminal.before).toEqual({
      P: q(1),
      B: q(0),
      C: q(0),
      consumed: [q(0), q(0), q(0)],
      worst: [0, 0, 0],
      mask: 0,
      chosen: -1,
    });
    expect(terminal.after).toEqual(terminal.before);
  });

  it("keeps proof .every sparse skipping, unbounded callback indices and short circuiting", () => {
    const result = evaluatePublicPathRelaxationPair(request());
    const before = result.before;
    const after = result.after;
    if (!before || !after) throw new Error("Missing test endpoints");
    const witness = { beforeValue: saved(before), afterValue: saved(after) };
    expect(checkPublicRelaxationProof(result, witness).status).toBe("PASS_ENDPOINT_PARITY");
    const consumed: [ReturnType<typeof q>, ReturnType<typeof q>, ReturnType<typeof q>] = [
      before.consumed[0],
      before.consumed[1],
      before.consumed[2],
    ];
    Reflect.deleteProperty(consumed, "1");
    const malformed = { ...result, before: { ...before, consumed } };
    expect(checkPublicRelaxationProof(malformed, witness).status).toBe("PASS_ENDPOINT_PARITY");
    consumed.push(q(0));
    expect(() => checkPublicRelaxationProof(malformed, witness)).toThrow(
      new TypeError("Cannot read properties of undefined (reading 'numerator')"),
    );
    expect(checkPublicRelaxationProof({ ...malformed, status: "NOTRUN" }, witness)).toEqual({
      status: "NOTRUN",
      reason: null,
      beforeParity: false,
      afterParity: false,
    });
  });
});
