import { beforeAll, describe, expect, it } from "vitest";

import { solveWithResearchCostModel } from "../solver";
import { createRustPhase2Solver, type RustCoreExports, type RustPhase2Solver } from "./rustCore";

const WASM_URL = new URL("../../public/solver_rs.wasm", import.meta.url);
const HORIZON_FACTOR = 0.75;
const NORM_POWER = 3;
const TOLERANCE = 0;

type Case = {
  name: string;
  start: { grade: "R" | "SR"; level: number; exp: number };
  stock: { blue: number; purple: number; yellow: number };
};

const CASES: Case[] = [
  {
    name: "R early balanced",
    start: { grade: "R", level: 1, exp: 0 },
    stock: { blue: 100, purple: 100, yellow: 100 },
  },
  {
    name: "SR middle scarce yellow",
    start: { grade: "SR", level: 8, exp: 500 },
    stock: { blue: 180, purple: 80, yellow: 30 },
  },
  {
    name: "SR late balanced",
    start: { grade: "SR", level: 13, exp: 1500 },
    stock: { blue: 120, purple: 120, yellow: 120 },
  },
];

function closeTo(actual: number, expected: number) {
  expect(actual).toBeCloseTo(expected, 9);
}

describe("rust phase2 wasm parity", () => {
  let solver: RustPhase2Solver;

  beforeAll(async () => {
    // @ts-expect-error Node builtin types are intentionally not part of the browser app tsconfig.
    const fs = (await import("node:fs")) as { readFileSync(path: URL): Uint8Array };
    const wasm = fs.readFileSync(WASM_URL);
    const instantiated = (await WebAssembly.instantiate(wasm)) as
      | WebAssembly.Instance
      | { instance: WebAssembly.Instance };
    const instance =
      instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
    solver = createRustPhase2Solver(instance.exports as unknown as RustCoreExports);
  });

  for (const testCase of CASES) {
    it(`matches JS phase2 root result for ${testCase.name}`, () => {
      const js = solveWithResearchCostModel(
        {
          start: testCase.start,
          stock: testCase.stock,
          strategy: "supply",
        },
        { kind: "availability-pnorm", horizonFactor: HORIZON_FACTOR, normPower: NORM_POWER },
        undefined,
        { toleranceOverride: TOLERANCE },
      ) as {
        best: {
          firstAction: string | null;
          successProbability: number;
          maxSuccessProbability: number;
          vector: { blue: number; purple: number; yellow: number };
        };
      };

      const rust = solver.solveRoot(
        testCase.start,
        testCase.stock,
        HORIZON_FACTOR,
        NORM_POWER,
        TOLERANCE,
      );

      expect(rust.firstAction).toBe(js.best.firstAction);
      closeTo(rust.successProbability, js.best.successProbability);
      closeTo(rust.maxSuccessProbability, js.best.maxSuccessProbability);
      closeTo(rust.vector.blue, js.best.vector.blue);
      closeTo(rust.vector.purple, js.best.vector.purple);
      closeTo(rust.vector.yellow, js.best.vector.yellow);
    });
  }
});
