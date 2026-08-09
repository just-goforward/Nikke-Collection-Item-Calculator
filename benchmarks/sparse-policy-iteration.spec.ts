import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { rustCoreExportsFromInstance } from "../src/wasm/rustLoader";
import { createRustMinEfSolver } from "../src/wasm/rustMinEfCore";
import { FIXED_SAFETY_GRID, type SolverScenario } from "./scenarios/fixed-grid";
import { solveSparsePolicyIteration } from "./sparse-policy-iteration";

const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);

async function instantiate(wasm: Uint8Array) {
  const result = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  return result instanceof WebAssembly.Instance ? result : result.instance;
}

function scenarioById(id: string) {
  const scenario = FIXED_SAFETY_GRID.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`Missing sparse policy-iteration fixture: ${id}`);
  return scenario;
}

describe("sparse constrained policy iteration", () => {
  let wasm: Uint8Array;

  beforeAll(() => {
    wasm = readFileSync(WASM_URL);
  });

  it.each([
    {
      id: "R0-semantic-60-120-900",
      group: "scarcity" as const,
      start: { grade: "R" as const, level: 0, exp: 0 },
      stock: { blue: 60, purple: 120, yellow: 900 },
    },
    scenarioById("R14e900-yellow30"),
    scenarioById("SR5-blue30"),
    scenarioById("SR10-yellow10"),
  ])("matches completed min-E[f] semantics for $id", async (scenario: SolverScenario) => {
    const sparseInstance = await instantiate(wasm);
    const sparse = solveSparsePolicyIteration(
      rustCoreExportsFromInstance(sparseInstance),
      { start: scenario.start, stock: scenario.stock, strategy: "supply" },
      { maxIterations: 40, maxStates: 1_200_000, memoTier: 22, timeBudgetMs: 120_000 },
    );

    const minEfInstance = await instantiate(wasm);
    const minEf = createRustMinEfSolver(
      rustCoreExportsFromInstance(minEfInstance),
    ).solveRootWithCandidates(scenario.start, scenario.stock, 0.75, 3, 0).root;

    expect(sparse.outcome).toBe("completed");
    expect(sparse.finalAction).toBe(minEf.firstAction);
    expect(sparse.finalValue?.success).toBeCloseTo(minEf.successProbability, 12);
    expect(sparse.finalValue?.cost).toBeCloseTo(minEf.expectedCost, 12);
    expect(sparse.finalValue?.vector[0]).toBeCloseTo(minEf.vector.blue, 10);
    expect(sparse.finalValue?.vector[1]).toBeCloseTo(minEf.vector.purple, 10);
    expect(sparse.finalValue?.vector[2]).toBeCloseTo(minEf.vector.yellow, 10);
    expect(sparse.iterations.length).toBeGreaterThan(0);
    for (const iteration of sparse.iterations) {
      expect(iteration.closureStates).toBe(sparse.closureStates);
      expect(iteration.improvementStates).toBe(iteration.closureStates);
      expect(iteration.evaluatedStates).toBe(iteration.closureStates);
      expect(iteration.successInvariantChecks).toBeGreaterThan(0);
    }
  });

  it("reports an iteration-budget outcome instead of treating an unstable policy as complete", async () => {
    const scenario = scenarioById("R14e900-yellow30");
    const instance = await instantiate(wasm);
    const result = solveSparsePolicyIteration(
      rustCoreExportsFromInstance(instance),
      { start: scenario.start, stock: scenario.stock, strategy: "supply" },
      { maxIterations: 1, maxStates: 1_200_000, memoTier: 22, timeBudgetMs: 120_000 },
    );

    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0]?.changes).toBeGreaterThan(0);
    expect(result.outcome).toBe("iteration_budget_exceeded");
  });

  it("does not report completion when the eligible closure exceeds the state budget", async () => {
    const scenario = scenarioById("R10-balanced300");
    const instance = await instantiate(wasm);
    const result = solveSparsePolicyIteration(
      rustCoreExportsFromInstance(instance),
      { start: scenario.start, stock: scenario.stock, strategy: "supply" },
      { maxIterations: 40, maxStates: 50_000, memoTier: 22, timeBudgetMs: 120_000 },
    );

    expect(result.outcome).toBe("state_budget_exceeded");
    expect(result.closureStates).toBe(50_001);
    expect(result.iterations).toHaveLength(0);
  });

  it("rejects nonzero tau because the exact success-preservation proof is tau=0 only", async () => {
    const scenario = scenarioById("SR10-yellow10");
    const instance = await instantiate(wasm);

    expect(() =>
      solveSparsePolicyIteration(
        rustCoreExportsFromInstance(instance),
        { start: scenario.start, stock: scenario.stock, strategy: "supply" },
        { tolerance: 1e-6 },
      ),
    ).toThrow("tau=0");
  });
});
