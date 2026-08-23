import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";
import { ACTIVE_SUPPLY_FORECAST_BASE_PROFILE } from "../shared/generated/supplyForecast";

import {
  buildCompactStateGraph,
  compactTransitionTable,
  decodeStateStockKey,
  expandFrontierKeysCpu,
  solveCompactMinEf,
} from "./compact-exact-graph";
import { enumerateCompletePolicies } from "./complete-policy-oracle";

const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);

type MinEfExports = WebAssembly.Exports & {
  configureMinEfMemo(value: number): void;
  solveMinEf(
    sid: number,
    blue: number,
    purple: number,
    yellow: number,
    gainBlue: number,
    gainPurple: number,
    gainYellow: number,
    horizon: number,
    power: number,
    tolerance: number,
  ): void;
  getSolveStatus(): number;
  minEfAction(): number;
  minEfSuccessProb(): number;
  minEfMaxSuccessProb(): number;
  minEfExpectedCost(): number;
  minEfVecB(): number;
  minEfVecP(): number;
  minEfVecY(): number;
};

describe("compact exact graph", () => {
  let exports: MinEfExports;

  beforeAll(async () => {
    const instantiated = await WebAssembly.instantiate(readFileSync(WASM_URL));
    const instance =
      instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
    exports = instance.exports as MinEfExports;
  });

  it("canonicalizes R15 to SR5 and preserves a strict stock-sum topological order", () => {
    const result = buildCompactStateGraph(
      { grade: "R", level: 14, exp: 900 },
      { blue: 10, purple: 10, yellow: 10 },
    );
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(
      result.graph.nodes.some((node) => node.state.grade === "R" && node.state.level === 15),
    ).toBe(false);
    for (const node of result.graph.nodes) {
      for (const edge of node.edges) {
        const success = result.graph.nodes[result.graph.indexByKey.get(edge.successKey) ?? -1];
        const failure = result.graph.nodes[result.graph.indexByKey.get(edge.failureKey) ?? -1];
        expect(success?.stockTotal).toBe(node.stockTotal - 1);
        expect(failure?.stockTotal).toBe(node.stockTotal - 1);
      }
    }
  });

  it("matches the Rust min-E[f] result on a small complete graph", () => {
    const start = { grade: "SR" as const, level: 10, exp: 2900 };
    const stock = { blue: 30, purple: 30, yellow: 30 };
    const result = buildCompactStateGraph(start, stock, { stateBudget: 100_000 });
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    const compact = solveCompactMinEf(result.graph);

    exports.configureMinEfMemo(18);
    exports.solveMinEf(
      809,
      stock.blue,
      stock.purple,
      stock.yellow,
      ACTIVE_SUPPLY_FORECAST_BASE_PROFILE.expectedGain.blue,
      ACTIVE_SUPPLY_FORECAST_BASE_PROFILE.expectedGain.purple,
      ACTIVE_SUPPLY_FORECAST_BASE_PROFILE.expectedGain.yellow,
      0.75,
      3,
      0,
    );
    expect(exports.getSolveStatus()).toBe(0);
    expect(["blue", "purple", "yellow"][exports.minEfAction()]).toBe(compact.root.action);
    expect(compact.root.successProbability).toBeCloseTo(exports.minEfSuccessProb(), 12);
    expect(compact.root.maxSuccessProbability).toBeCloseTo(exports.minEfMaxSuccessProb(), 12);
    expect(compact.root.expectedCost).toBeCloseTo(exports.minEfExpectedCost(), 12);
    expect(compact.root.vector).toEqual({
      blue: expect.closeTo(exports.minEfVecB(), 12),
      purple: expect.closeTo(exports.minEfVecP(), 12),
      yellow: expect.closeTo(exports.minEfVecY(), 12),
    });
  });

  it("enumerates every tiny deterministic policy and agrees with Bellman selection", () => {
    const result = buildCompactStateGraph(
      { grade: "SR", level: 14, exp: 2900 },
      { blue: 10, purple: 10, yellow: 10 },
    );
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    const compact = solveCompactMinEf(result.graph);
    const costByKey = new Map(
      [...compact.values.entries()].map(([key, value]) => [key, value.expectedCost]),
    );
    const oracle = enumerateCompletePolicies(
      result.graph,
      (key) => costByKey.get(key) ?? 0,
      100_000,
    );
    expect(oracle.root.action).toBe(compact.root.action);
    expect(oracle.root.successProbability).toBeCloseTo(compact.root.successProbability, 12);
    expect(oracle.policiesEvaluated).toBeGreaterThan(0);
  });

  it("uses the same transition table for deterministic CPU frontier expansion", () => {
    const result = buildCompactStateGraph(
      { grade: "SR", level: 14, exp: 2900 },
      { blue: 10, purple: 10, yellow: 10 },
    );
    if (result.outcome !== "completed") throw new Error("Fixture graph did not complete.");
    const root = result.graph.nodes[result.graph.indexByKey.get(result.graph.rootKey) ?? -1];
    if (!root) throw new Error("Fixture root is missing.");
    const expected = [
      ...new Set(root.edges.flatMap((edge) => [edge.successKey, edge.failureKey])),
    ].sort((left, right) => left - right);
    expect(expandFrontierKeysCpu([root.key], compactTransitionTable())).toEqual(expected);
    expect(decodeStateStockKey(root.key).stock).toEqual({ blue: 1, purple: 1, yellow: 1 });
  });

  it("does not expand terminal states even when stock remains", () => {
    const result = buildCompactStateGraph(
      { grade: "SR", level: 15, exp: 0 },
      { blue: 10, purple: 10, yellow: 10 },
    );
    if (result.outcome !== "completed") throw new Error("Terminal fixture did not complete.");
    expect(expandFrontierKeysCpu([result.graph.rootKey])).toEqual([]);
  });

  it("fails closed at the pre-registered state budget", () => {
    expect(
      buildCompactStateGraph(
        { grade: "R", level: 10, exp: 0 },
        { blue: 300, purple: 300, yellow: 300 },
        { stateBudget: 32, edgeBudget: 192 },
      ),
    ).toMatchObject({ outcome: "budget_exceeded", reason: "state_budget", states: 32 });
  });
});
