import { beforeAll, describe, expect, it } from "vitest";

import { solveWithResearchCostModel } from "../solver/solve";
import { solveRustMinEfProduct } from "./rustMinEfSolver";
import { solveRustPhase2 } from "./rustPhase2ProductSolver";
import { createRustPhase2ResearchSolver } from "./rustPhase2ResearchCore";
import type { RustCoreExports, RustPhase2ResearchSolver } from "./rustTypes";

const WASM_URL = new URL("../../public/solver_rs.wasm", import.meta.url);
const HORIZON_FACTOR = 0.75;
const NORM_POWER = 3;
const TOLERANCE = 0;
const MONTE_CARLO_RUNS = 256;
const MONTE_CARLO_SEED = 20260505;

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

function f64Bits(value: number) {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}

describe("rust phase2 wasm parity", () => {
  let solver: RustPhase2ResearchSolver;
  let wasm: Uint8Array;
  let wasmDataUrl: string;

  beforeAll(async () => {
    const fs = (await import("node:fs")) as { readFileSync(path: URL): Uint8Array };
    wasm = fs.readFileSync(WASM_URL);
    wasmDataUrl = `data:application/wasm;base64,${Buffer.from(wasm).toString("base64")}`;
    const instantiated = (await WebAssembly.instantiate(wasm)) as
      | WebAssembly.Instance
      | { instance: WebAssembly.Instance };
    const instance =
      instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
    solver = createRustPhase2ResearchSolver(instance.exports as unknown as RustCoreExports);
  });

  it("keeps the min-E[f] policy when a dominance cap would erase absolute inventory cost", async () => {
    const instantiated = (await WebAssembly.instantiate(wasm)) as
      | WebAssembly.Instance
      | { instance: WebAssembly.Instance };
    const instance =
      instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
    const exports = instance.exports as unknown as RustCoreExports;
    if (!exports.configureMinEfMemo || !exports.minEfAction || !exports.minEfExpectedCost) {
      throw new Error("min-E[f] root exports are required for the dominance-cap regression test.");
    }

    exports.configureMinEfMemo(21);
    exports.solveMinEf(0, 60, 120, 900, HORIZON_FACTOR, NORM_POWER, TOLERANCE);

    expect(exports.getSolveStatus?.()).toBe(0);
    expect(["blue", "purple", "yellow"][exports.minEfAction()]).toBe("blue");
    // Semantic golden for absolute-inventory handling. Do not refresh expected values solely
    // because this assertion fails. Revalidate the tau gate and dominance-cap distinction first.
    expect(f64Bits(exports.minEfExpectedCost())).toBe(0x3fbf64e435ab1f1en);
  });

  it("keeps the min-E[f] probe-order node count invariant", async () => {
    const instantiated = (await WebAssembly.instantiate(wasm)) as
      | WebAssembly.Instance
      | { instance: WebAssembly.Instance };
    const instance =
      instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
    const exports = instance.exports as unknown as RustCoreExports;
    if (!exports.configureMinEfMemo || !exports.minEfNodeCount) {
      throw new Error("min-E[f] memo configuration exports are required for the golden test.");
    }

    // This count depends on the component-wise hash, tier-21 mask, and a fresh instance. The
    // objective parameters do not alter the expanded state set, but are fixed for auditability.
    // Verify the dominance-cap semantic fixture above before accepting any change to this number.
    exports.configureMinEfMemo(21);
    exports.solveMinEf(30, 100, 100, 100, HORIZON_FACTOR, NORM_POWER, TOLERANCE);

    expect(exports.getSolveStatus?.()).toBe(0);
    expect(exports.minEfNodeCount()).toBe(218_278);
  });

  it("preserves raw inventory above memo saturation when choosing the phase2 root action", () => {
    const start = { grade: "R" as const, level: 0, exp: 0 };
    const stock = { blue: 2_210, purple: 890, yellow: 450 };
    const js = solveWithResearchCostModel(
      { start, stock, strategy: "supply" },
      { kind: "availability-pnorm", horizonFactor: HORIZON_FACTOR, normPower: NORM_POWER },
      undefined,
      { toleranceOverride: TOLERANCE },
    ) as { best: { firstAction: string | null } };
    const rust = solver.solveRoot(start, stock, HORIZON_FACTOR, NORM_POWER, TOLERANCE);

    expect(js.best.firstAction).toBe("purple");
    expect(rust.firstAction).toBe("purple");
  });

  it("preserves remainder pieces in phase2 action, vector, and availability cost parity", async () => {
    const start = { grade: "R" as const, level: 5, exp: 0 };
    const stock = { blue: 880, purple: 439, yellow: 111 };
    const js = solveWithResearchCostModel(
      { start, stock, strategy: "supply" },
      { kind: "availability-pnorm", horizonFactor: HORIZON_FACTOR, normPower: NORM_POWER },
      undefined,
      { toleranceOverride: TOLERANCE },
    ) as {
      best: {
        availabilityCost: number;
        firstAction: string | null;
        vector: { blue: number; purple: number; yellow: number };
      };
    };
    const rust = (await solveRustPhase2({ start, stock, strategy: "supply" }, wasmDataUrl)) as {
      best: {
        availabilityCost: number;
        firstAction: string | null;
        vector: { blue: number; purple: number; yellow: number };
      };
    };

    expect(js.best.firstAction).toBe("purple");
    expect(rust.best.firstAction).toBe(js.best.firstAction);
    closeTo(rust.best.vector.blue, js.best.vector.blue);
    closeTo(rust.best.vector.purple, js.best.vector.purple);
    closeTo(rust.best.vector.yellow, js.best.vector.yellow);
    closeTo(rust.best.availabilityCost, js.best.availabilityCost);
  }, 30_000);

  it("clamps over-range uses at the moment-vector ABI boundary", async () => {
    const instantiated = (await WebAssembly.instantiate(wasm)) as
      | WebAssembly.Instance
      | { instance: WebAssembly.Instance };
    const instance =
      instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
    const exports = instance.exports as unknown as RustCoreExports;
    const solveCore = exports.solveCore;
    const momentVector = exports.momentVectorAfterFirstActionFromPolicy;
    const meanB = exports.momentMeanBUses;
    const meanP = exports.momentMeanPUses;
    const meanY = exports.momentMeanYUses;
    const nodeCount = exports.momentVectorNodeCount;
    if (!solveCore || !momentVector || !meanB || !meanP || !meanY || !nodeCount) {
      throw new Error("Phase2 moment-vector exports are required for the ABI boundary test.");
    }

    const run = (blue: number, purple: number, yellow: number) => {
      solveCore(0, 2_260, 890, 450, HORIZON_FACTOR, NORM_POWER, TOLERANCE);
      expect(exports.getSolveStatus?.()).toBe(0);
      momentVector(0, blue, purple, yellow, 0);
      expect(exports.getSolveStatus?.()).toBe(0);
      return {
        means: [meanB(), meanP(), meanY()],
        nodes: nodeCount(),
      };
    };

    expect(run(226, 89, 45)).toEqual(run(220, 88, 44));
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

    it(`matches JS phase2 Monte Carlo for ${testCase.name}`, () => {
      const js = solveWithResearchCostModel(
        {
          start: testCase.start,
          stock: testCase.stock,
          strategy: "supply",
          monteCarloRuns: MONTE_CARLO_RUNS,
          monteCarloSeed: MONTE_CARLO_SEED,
        },
        { kind: "availability-pnorm", horizonFactor: HORIZON_FACTOR, normPower: NORM_POWER },
        undefined,
        { toleranceOverride: TOLERANCE },
      ) as {
        monteCarlo: {
          runs: number;
          completed: number;
          successProbability: number;
          vector: { blue: number; purple: number; yellow: number };
        };
      };

      solver.solveRoot(testCase.start, testCase.stock, HORIZON_FACTOR, NORM_POWER, TOLERANCE);
      const rust = solver.simulatePolicy(
        testCase.start,
        testCase.stock,
        MONTE_CARLO_RUNS,
        MONTE_CARLO_SEED,
        HORIZON_FACTOR,
        NORM_POWER,
        TOLERANCE,
      );

      expect(rust.runs).toBe(js.monteCarlo.runs);
      expect(rust.completed).toBe(js.monteCarlo.completed);
      closeTo(rust.successProbability, js.monteCarlo.successProbability);
      closeTo(rust.vector.blue, js.monteCarlo.vector.blue);
      closeTo(rust.vector.purple, js.monteCarlo.vector.purple);
      closeTo(rust.vector.yellow, js.monteCarlo.vector.yellow);
    });

    it(`pairs identical first actions with bit-exact zero delta for ${testCase.name}`, () => {
      const root = solver.solveRoot(
        testCase.start,
        testCase.stock,
        HORIZON_FACTOR,
        NORM_POWER,
        TOLERANCE,
      );
      expect(root.firstAction).not.toBeNull();

      const pair = solver.estimateExpectedCostPairFromCurrent(
        testCase.start,
        testCase.stock,
        root.firstAction as "blue" | "purple" | "yellow",
        root.firstAction as "blue" | "purple" | "yellow",
        MONTE_CARLO_RUNS,
        MONTE_CARLO_SEED,
        HORIZON_FACTOR,
        NORM_POWER,
      );

      expect(pair.runs).toBe(MONTE_CARLO_RUNS);
      expect(pair.meanDelta).toBe(0);
      expect(pair.deltaSumSq).toBe(0);
      expect(pair.standardError).toBe(0);
      expect(pair.upper95).toBe(0);
    });

    it(`matches phase2 candidate means with A2 moment means for ${testCase.name}`, () => {
      const candidates = solver.rootCandidates(
        testCase.start,
        testCase.stock,
        HORIZON_FACTOR,
        NORM_POWER,
        TOLERANCE,
      );

      for (const candidate of candidates) {
        const moment = solver.estimateA2SurrogateAfterFirstActionFromCurrent(
          testCase.start,
          testCase.stock,
          candidate.firstAction,
          HORIZON_FACTOR,
          NORM_POWER,
        );

        closeTo(moment.mean.blue, candidate.vector.blue);
        closeTo(moment.mean.purple, candidate.vector.purple);
        closeTo(moment.mean.yellow, candidate.vector.yellow);
        expect(moment.covariance.blueBlue).toBeGreaterThanOrEqual(0);
        expect(moment.covariance.purplePurple).toBeGreaterThanOrEqual(0);
        expect(moment.covariance.yellowYellow).toBeGreaterThanOrEqual(0);
        expect(moment.surrogateCost).toBeGreaterThanOrEqual(0);
      }
    });

    it(`matches JS phase2 product contract fields for ${testCase.name}`, async () => {
      const input = {
        start: testCase.start,
        stock: testCase.stock,
        strategy: "supply" as const,
        monteCarloRuns: MONTE_CARLO_RUNS,
        monteCarloSeed: MONTE_CARLO_SEED,
      };
      const js = solveWithResearchCostModel(
        input,
        { kind: "availability-pnorm", horizonFactor: HORIZON_FACTOR, normPower: NORM_POWER },
        undefined,
        { collectGateAudit: false, toleranceOverride: TOLERANCE },
      ) as {
        possible: boolean;
        candidateCount: number;
        best: {
          firstAction: string | null;
          run: { count: number };
          successProbability: number;
          probabilityGap: number;
          vector: { blue: number; purple: number; yellow: number };
        };
        route: unknown[];
        monteCarlo: {
          runs: number;
          completed: number;
          successProbability: number;
          vector: { blue: number; purple: number; yellow: number };
        };
        topCandidates: Array<{
          firstAction: string | null;
          run: { count: number } | null;
          successProbability: number;
          probabilityGap: number;
          vector: { blue: number; purple: number; yellow: number };
          resourceCost: number;
        }>;
      };
      const rust = (await solveRustPhase2(input, wasmDataUrl)) as unknown as typeof js;

      expect(rust.possible).toBe(js.possible);
      expect(rust.candidateCount).toBe(js.candidateCount);
      expect(rust.best.firstAction).toBe(js.best.firstAction);
      expect(rust.best.run.count).toBe(js.best.run.count);
      closeTo(rust.best.successProbability, js.best.successProbability);
      closeTo(rust.best.probabilityGap, js.best.probabilityGap);
      closeTo(rust.best.vector.blue, js.best.vector.blue);
      closeTo(rust.best.vector.purple, js.best.vector.purple);
      closeTo(rust.best.vector.yellow, js.best.vector.yellow);

      expect(rust.route).toEqual(js.route);
      expect(rust.monteCarlo.runs).toBe(js.monteCarlo.runs);
      expect(rust.monteCarlo.completed).toBe(js.monteCarlo.completed);
      closeTo(rust.monteCarlo.successProbability, js.monteCarlo.successProbability);
      closeTo(rust.monteCarlo.vector.blue, js.monteCarlo.vector.blue);
      closeTo(rust.monteCarlo.vector.purple, js.monteCarlo.vector.purple);
      closeTo(rust.monteCarlo.vector.yellow, js.monteCarlo.vector.yellow);

      expect(rust.topCandidates.length).toBe(js.topCandidates.length);
      for (const [index, rustCandidate] of rust.topCandidates.entries()) {
        const jsCandidate = js.topCandidates[index];
        if (!jsCandidate) throw new Error(`Missing JS top candidate at index ${index}.`);
        expect(rustCandidate.firstAction).toBe(jsCandidate.firstAction);
        expect(rustCandidate.run?.count).toBe(jsCandidate.run?.count);
        closeTo(rustCandidate.successProbability, jsCandidate.successProbability);
        closeTo(rustCandidate.probabilityGap, jsCandidate.probabilityGap);
        closeTo(rustCandidate.vector.blue, jsCandidate.vector.blue);
        closeTo(rustCandidate.vector.purple, jsCandidate.vector.purple);
        closeTo(rustCandidate.vector.yellow, jsCandidate.vector.yellow);
        closeTo(rustCandidate.resourceCost, jsCandidate.resourceCost);
      }
    });

    it(`emits a phase2-shaped min-E[f] product result for ${testCase.name}`, async () => {
      const input = {
        start: testCase.start,
        stock: testCase.stock,
        strategy: "supply" as const,
        monteCarloRuns: MONTE_CARLO_RUNS,
        monteCarloSeed: MONTE_CARLO_SEED,
      };
      const phase2 = (await solveRustPhase2(input, wasmDataUrl)) as {
        possible: boolean;
        best: {
          successProbability: number;
          maxSuccessProbability: number;
          probabilityGap: number;
          resourceCost: number;
        };
        route: unknown[];
        monteCarlo: {
          runs: number;
          completed: number;
          successProbability: number;
          quantiles?: unknown;
          depletion?: number;
        };
        topCandidates: Array<{ probabilityGap: number; resourceCost: number }>;
      };
      const minef = (await solveRustMinEfProduct(input, wasmDataUrl)) as typeof phase2;

      expect(minef.possible).toBe(phase2.possible);
      expect(Object.keys(minef).sort()).toEqual(Object.keys(phase2).sort());
      closeTo(minef.best.successProbability, phase2.best.successProbability);
      closeTo(minef.best.maxSuccessProbability, phase2.best.maxSuccessProbability);
      expect(minef.best.probabilityGap).toBeLessThanOrEqual(1e-9);
      expect(minef.best.resourceCost).toBeGreaterThan(0);
      expect(minef.route.length).toBeGreaterThan(0);
      expect(minef.monteCarlo.runs).toBe(MONTE_CARLO_RUNS);
      expect(minef.monteCarlo.quantiles).toBeDefined();
      expect(minef.monteCarlo.depletion).toBeGreaterThanOrEqual(0);
      expect(minef.topCandidates.length).toBeGreaterThan(0);
      for (let index = 1; index < minef.topCandidates.length; index += 1) {
        const previous = minef.topCandidates[index - 1];
        const current = minef.topCandidates[index];
        if (!previous || !current) throw new Error(`Missing min-E[f] top candidate at ${index}.`);
        if (previous.probabilityGap <= 1e-9 && current.probabilityGap <= 1e-9) {
          expect(current.resourceCost).toBeGreaterThanOrEqual(previous.resourceCost - 1e-12);
        }
      }
    });
  }

  it("falls back from min-E[f] to rust phase2 instead of JS for a large R0 inventory", async () => {
    const minef = (await solveRustMinEfProduct(
      {
        start: { grade: "R", level: 0, exp: 0 },
        stock: { blue: 400, purple: 200, yellow: 100 },
        strategy: "supply",
        monteCarloRuns: 0,
      },
      wasmDataUrl,
    )) as {
      possible: boolean;
      stats?: {
        fallbackFrom?: string;
        fallbackReason?: string;
        memoryStrategy?: string;
        minEfMemoTier?: number;
        phase2MemoRetried?: boolean;
        phase2MemoTier?: number;
        solverBackend?: string;
      };
    };

    expect(minef.possible).toBe(true);
    expect(minef.stats).toMatchObject({
      fallbackFrom: "rust-min-ef",
      fallbackReason: "memo_full",
      memoryStrategy: "balanced-v1",
      minEfMemoTier: 21,
      phase2MemoRetried: false,
      phase2MemoTier: 22,
      solverBackend: "rust-phase2",
    });
  });
});
