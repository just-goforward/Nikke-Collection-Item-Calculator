import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { rustCoreExportsFromInstance } from "../src/wasm/rustLoader";
import { createRustMinEfSolver } from "../src/wasm/rustMinEfCore";
import { createRustPhase2Solver } from "../src/wasm/rustPhase2Core";
import { hpCandidateById } from "./min-ef-hp-model";
import { createHpLadderSession } from "./min-ef-hp-policy";

const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);

let wasm: Uint8Array;

beforeAll(async () => {
  wasm = await readFile(WASM_URL);
});

async function instantiate(): Promise<WebAssembly.Instance> {
  const result = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  return result instanceof WebAssembly.Instance ? result : result.instance;
}

describe("Rust min-E[f] H/p research ladder", () => {
  it("matches the current product min-E[f] root at H=0.75, p=3", async () => {
    const candidate = hpCandidateById("H0.75-p3");
    const [minEfInstance, phase2Instance, referenceInstance] = await Promise.all([
      instantiate(),
      instantiate(),
      instantiate(),
    ]);
    const session = createHpLadderSession(minEfInstance, phase2Instance, candidate);
    const input = {
      start: { grade: "SR" as const, level: 10, exp: 0 },
      stock: { blue: 101, purple: 109, yellow: 119 },
      strategy: "supply" as const,
    };
    const screened = session.screenRoot(input, "baseline-equivalence");
    const reference = createRustMinEfSolver(rustCoreExportsFromInstance(referenceInstance));
    reference.configureMemoTier(21);
    const policy = reference.solveRootWithCandidates(input.start, input.stock, 0.75, 3, 0);

    expect(screened.selectedBackend).toBe("rust-min-ef");
    expect(screened.metrics?.firstAction).toBe(policy.root.firstAction);
    expect(screened.metrics?.successProbability).toBe(policy.root.successProbability);
    expect(screened.metrics?.expectedConsumption).toEqual(policy.root.vector);
    expect(screened.metrics?.optimizerExpectedCost).toBe(policy.root.expectedCost);
    expect(screened.metrics?.nodeCount).toBe(policy.nodeCount);
    session.release();
    reference.releaseMemo();
  });

  it("accepts every p boundary, including infinity, without NaN metrics", async () => {
    for (const id of [
      "H0.25-p3",
      "H0.5-p3",
      "H0.625-p3",
      "H0.75-p1",
      "H0.75-p1.5",
      "H0.75-p2",
      "H0.75-p3",
      "H0.75-p4",
      "H0.75-p6",
      "H0.75-pinf",
      "H0.875-p3",
      "H1-p3",
      "H1.25-p3",
    ]) {
      const [minEfInstance, phase2Instance] = await Promise.all([instantiate(), instantiate()]);
      const session = createHpLadderSession(minEfInstance, phase2Instance, hpCandidateById(id));
      const screened = session.screenRoot(
        {
          start: { grade: "SR", level: 14, exp: 2900 },
          stock: { blue: 101, purple: 109, yellow: 119 },
          strategy: "supply",
        },
        id,
      );
      expect(screened.metrics, id).not.toBeNull();
      expect(
        Object.values(screened.metrics ?? {}).every(
          (value) => typeof value !== "number" || !Number.isNaN(value),
        ),
        id,
      ).toBe(true);
      session.release();
    }
  });

  it("uses the same H/p values when a tier-21 min-E[f] solve falls back to tier-22 phase2", async () => {
    const [minEfInstance, phase2Instance, referenceInstance] = await Promise.all([
      instantiate(),
      instantiate(),
      instantiate(),
    ]);
    const candidate = hpCandidateById("H0.5-p1.5");
    const session = createHpLadderSession(minEfInstance, phase2Instance, candidate);
    const input = {
      start: { grade: "R" as const, level: 10, exp: 0 },
      stock: { blue: 300, purple: 300, yellow: 300 },
      strategy: "supply" as const,
    };
    const screened = session.screenRoot(input, "phase2-fallback");
    const reference = createRustPhase2Solver(rustCoreExportsFromInstance(referenceInstance));
    reference.configureMemoTier(22);
    const policy = reference.buildPolicy(input.start, input.stock, candidate.horizonFactor, 1.5, 0);
    expect(screened.minEfOutcome).toBe("memo_full");
    expect(screened.phase2Outcome).toBe("completed");
    expect(screened.selectedBackend).toBe("rust-phase2");
    expect(screened.metrics?.firstAction).toBe(policy.root.firstAction);
    expect(screened.metrics?.successProbability).toBe(policy.root.successProbability);
    expect(screened.metrics?.expectedConsumption).toEqual(policy.root.vector);
    expect(screened.metrics?.optimizerExpectedCost).toBe(
      policy.candidates.find((entry) => entry.firstAction === policy.root.firstAction)
        ?.resourceCost,
    );
    session.release();
    reference.releaseMemo();
  });
});
