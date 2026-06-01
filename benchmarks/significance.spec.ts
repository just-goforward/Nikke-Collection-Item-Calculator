import { describe, expect, it } from "vitest";

import { cvarUpperTail } from "./metrics";
import { gatePairedSeeds } from "./significance-gate";
import { holmBonferroniWorseningDecisions, pairedBootstrapImprovement } from "./tail-statistics";

// Locks the way the significance step uses the existing CRN paired-bootstrap primitive for the
// supplyDebt y-axis. Two facts drive the wiring:
//   1. statistic = upper-tail CVaR90, lower-is-better; the "display" call (baseline=A,
//      candidate=cand) yields an improvement oriented so positive = candidate lowers the tail,
//      and confidenceLower > 0 means the whole CI is on the improvement side.
//   2. The library's adversePValue + Holm are built to confirm WORSENING (low p => confirmed
//      worse). To confirm IMPROVEMENT we swap roles (baseline=cand, candidate=A): then a low
//      adversePValue means "A is confirmed worse than cand" = cand significantly improves.
const cvar90 = (values: number[]) => cvarUpperTail(values, 0.9);

describe("supplyDebt significance usage", () => {
  it("confirms a strictly lower-debt candidate as a significant improvement", () => {
    const baseline = Array.from({ length: 200 }, (_, i) => (i < 20 ? 120 : 10));
    const candidate = baseline.map((value) => value - 30);

    const display = pairedBootstrapImprovement(baseline, candidate, {
      higherIsBetter: false,
      statistic: cvar90,
      resamples: 1000,
      seed: 20260505,
    });
    expect(display.pointImprovement).toBeCloseTo(30, 6); // cvar90(A) - cvar90(cand) = +30
    expect(display.confidenceLower).toBeGreaterThan(0); // entire CI above 0

    // swapped-roles improvement test -> low adverse p-value -> Holm confirms improvement
    const improveTest = pairedBootstrapImprovement(candidate, baseline, {
      higherIsBetter: false,
      statistic: cvar90,
      resamples: 1000,
      seed: 20260505,
    });
    expect(improveTest.adversePValue).toBeLessThan(0.05);
    const [decision] = holmBonferroniWorseningDecisions([
      { id: "cand", adversePValue: improveTest.adversePValue },
    ]);
    expect(decision.confirmedWorsening).toBe(true); // reinterpreted as confirmed improvement
  });

  it("does not confirm improvement when the candidate is identical to A", () => {
    const baseline = Array.from({ length: 100 }, (_, i) => (i < 10 ? 100 : 5));
    const candidate = [...baseline];

    const display = pairedBootstrapImprovement(baseline, candidate, {
      higherIsBetter: false,
      statistic: cvar90,
      resamples: 500,
      seed: 20260505,
    });
    expect(display.pointImprovement).toBeCloseTo(0, 9);
    expect(display.confidenceLower).toBeLessThanOrEqual(0); // CI not strictly positive

    const improveTest = pairedBootstrapImprovement(candidate, baseline, {
      higherIsBetter: false,
      statistic: cvar90,
      resamples: 500,
      seed: 20260505,
    });
    const [decision] = holmBonferroniWorseningDecisions([
      { id: "cand", adversePValue: improveTest.adversePValue },
    ]);
    expect(decision.confirmedWorsening).toBe(false);
  });

  it("is deterministic for a fixed seed", () => {
    const baseline = Array.from({ length: 80 }, (_, i) => (i % 7) + (i < 8 ? 50 : 0));
    const candidate = baseline.map((value) => value * 0.8);
    const options = { higherIsBetter: false, statistic: cvar90, resamples: 400, seed: 7 } as const;
    expect(pairedBootstrapImprovement(baseline, candidate, options)).toEqual(
      pairedBootstrapImprovement(baseline, candidate, options),
    );
  });
});

// Locks the completion gate that matches the deep journey y-axis WITHOUT breaking CRN pairing:
// a seed under-completed by EITHER arm is dropped from BOTH arms.
describe("significance completion gate (gatePairedSeeds)", () => {
  it("keeps all seeds when both arms complete every seed", () => {
    const base = [
      { seed: 1, completionRate: 0.999, samples: [10, 20] },
      { seed: 2, completionRate: 0.998, samples: [11, 21] },
    ];
    const cand = [
      { seed: 1, completionRate: 0.997, samples: [5, 15] },
      { seed: 2, completionRate: 0.996, samples: [6, 16] },
    ];
    const g = gatePairedSeeds(base, cand);
    expect(g.status).toBe("completed");
    expect(g.seedsKept).toBe(2);
    expect(g.seedsGated).toHaveLength(0);
    expect(g.basePool).toEqual([10, 20, 11, 21]);
    expect(g.candPool).toEqual([5, 15, 6, 16]);
    expect(g.completionMin).toBeCloseTo(0.996, 9);
  });

  it("drops a candidate-under-completed seed from BOTH arms (CRN preserved)", () => {
    const base = [
      { seed: 1, completionRate: 0.999, samples: [10, 20] },
      { seed: 2, completionRate: 0.999, samples: [11, 21] }, // A completes seed 2 fine
    ];
    const cand = [
      { seed: 1, completionRate: 0.998, samples: [5, 15] },
      { seed: 2, completionRate: 0.99, samples: [6, 16] }, // < 0.995 -> seed 2 gated
    ];
    const g = gatePairedSeeds(base, cand);
    expect(g.status).toBe("completed");
    expect(g.seedsKept).toBe(1);
    expect(g.seedsGated.map((s) => s.seed)).toEqual([2]);
    // A's seed-2 samples are dropped too, even though A completed them — keeps the pairing aligned.
    expect(g.basePool).toEqual([10, 20]);
    expect(g.candPool).toEqual([5, 15]);
    expect(g.basePool.length).toBe(g.candPool.length);
    expect(g.completionMin).toBeCloseTo(0.99, 9);
  });

  it("drops a baseline-under-completed seed from BOTH arms", () => {
    const base = [
      { seed: 1, completionRate: 0.991, samples: [10, 20] }, // A under-completes seed 1
      { seed: 2, completionRate: 0.999, samples: [11, 21] },
    ];
    const cand = [
      { seed: 1, completionRate: 0.999, samples: [5, 15] }, // cand completes it, still dropped
      { seed: 2, completionRate: 0.999, samples: [6, 16] },
    ];
    const g = gatePairedSeeds(base, cand);
    expect(g.seedsGated.map((s) => s.seed)).toEqual([1]);
    expect(g.basePool).toEqual([11, 21]);
    expect(g.candPool).toEqual([6, 16]);
  });

  it("reports judgement_incomplete when every seed is gated", () => {
    const base = [{ seed: 1, completionRate: 0.5, samples: [1, 2] }];
    const cand = [{ seed: 1, completionRate: 0.999, samples: [3, 4] }];
    const g = gatePairedSeeds(base, cand);
    expect(g.status).toBe("judgement_incomplete");
    expect(g.reason).toBe("all_seeds_gated");
    expect(g.basePool).toHaveLength(0);
    expect(g.candPool).toHaveLength(0);
  });

  it("honors a custom threshold and always returns equal-length pools", () => {
    const base = [
      { seed: 1, completionRate: 0.992, samples: [10] },
      { seed: 2, completionRate: 0.999, samples: [11] },
    ];
    const cand = [
      { seed: 1, completionRate: 0.993, samples: [5] },
      { seed: 2, completionRate: 0.999, samples: [6] },
    ];
    // threshold 0.99 keeps both seeds; default 0.995 would gate seed 1.
    const lenient = gatePairedSeeds(base, cand, 0.99);
    expect(lenient.seedsKept).toBe(2);
    expect(lenient.basePool.length).toBe(lenient.candPool.length);
    const strict = gatePairedSeeds(base, cand);
    expect(strict.seedsKept).toBe(1);
    expect(strict.basePool.length).toBe(strict.candPool.length);
  });
});
