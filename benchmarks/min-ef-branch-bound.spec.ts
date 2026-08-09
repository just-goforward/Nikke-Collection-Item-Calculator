import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { KIT_ORDER, type KitVector } from "../src/solver/domain";
import { rustCoreExportsFromInstance } from "../src/wasm/rustLoader";
import { createRustMinEfSolver } from "../src/wasm/rustMinEfCore";
import { enumerateTinyMinEf, immediateConsumptionLowerBound } from "./min-ef-branch-bound";

const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);

async function instantiate(wasm: Uint8Array) {
  const result = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  return result instanceof WebAssembly.Instance ? result : result.instance;
}

describe("min-E[f] branch-and-bound lower bound", () => {
  let wasm: Uint8Array;

  beforeAll(() => {
    wasm = readFileSync(WASM_URL);
  });

  it("is component-wise monotone after the immediate action", () => {
    const initial = { blue: 41, purple: 31, yellow: 21 };
    const startUses = { blue: 4, purple: 3, yellow: 2 };
    const remaining = { blue: 3, purple: 2, yellow: 1 };

    for (const action of KIT_ORDER) {
      const bound = immediateConsumptionLowerBound(initial, startUses, remaining, action);
      const later = { ...remaining, blue: Math.max(0, remaining.blue - 1) };
      expect(
        immediateConsumptionLowerBound(initial, startUses, later, action),
      ).toBeGreaterThanOrEqual(bound);
    }
  });

  it.each([
    {
      start: { grade: "R" as const, level: 14, exp: 900 },
      stock: { blue: 31, purple: 21, yellow: 11 },
    },
    {
      start: { grade: "SR" as const, level: 10, exp: 0 },
      stock: { blue: 41, purple: 31, yellow: 21 },
    },
    {
      start: { grade: "SR" as const, level: 14, exp: 2_900 },
      stock: { blue: 21, purple: 21, yellow: 21 },
    },
  ])("matches Rust min-E[f] on $start.grade$start.level / $stock", async ({ start, stock }) => {
    const direct = enumerateTinyMinEf(start, stock);
    const instance = await instantiate(wasm);
    const rust = createRustMinEfSolver(
      rustCoreExportsFromInstance(instance),
    ).solveRootWithCandidates(start, stock, 0.75, 3, 0).root;

    expect(direct.root.action).toBe(rust.firstAction);
    expect(direct.root.success).toBeCloseTo(rust.successProbability, 12);
    expect(direct.root.maxSuccess).toBeCloseTo(rust.maxSuccessProbability, 12);
    expect(direct.root.expectedCost).toBeCloseTo(rust.expectedCost, 12);
    expect(direct.root.vector.blue).toBeCloseTo(rust.vector.blue, 10);
    expect(direct.root.vector.purple).toBeCloseTo(rust.vector.purple, 10);
    expect(direct.root.vector.yellow).toBeCloseTo(rust.vector.yellow, 10);
    expect(direct.stats.boundViolations).toBe(0);
  });

  it("finds no lower-bound violation across a small exhaustive stock grid", () => {
    const states = [
      { grade: "R" as const, level: 14, exp: 900 },
      { grade: "SR" as const, level: 10, exp: 0 },
      { grade: "SR" as const, level: 14, exp: 2_900 },
    ];
    const stocks: KitVector[] = [];
    for (let blue = 1; blue <= 3; blue += 1) {
      for (let purple = 1; purple <= 3; purple += 1) {
        for (let yellow = 1; yellow <= 3; yellow += 1) {
          stocks.push({ blue: blue * 10 + 1, purple: purple * 10 + 1, yellow: yellow * 10 + 1 });
        }
      }
    }

    let checkedStates = 0;
    for (const start of states) {
      for (const stock of stocks) {
        const result = enumerateTinyMinEf(start, stock);
        expect(result.stats.boundViolations).toBe(0);
        checkedStates += result.stats.memoStates;
      }
    }
    expect(checkedStates).toBeGreaterThan(1_000);
  });
});
