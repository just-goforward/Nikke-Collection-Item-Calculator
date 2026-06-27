import type { Kit, KitVector } from "./domain";
import {
  clamp,
  convertState,
  decrementStock,
  isConvertStateNormalized,
  isTerminalNormalized,
  KIT_ORDER,
  normalizeState,
  transitionNormalized,
} from "./domain";
import type { NormalizedSolverInput } from "./input";
import type { ActionFor } from "./routes";
import { makeStageReachDistribution, stageRank } from "./stageReach";

function makeRandom(seed: number) {
  let value = seed >>> 0;
  return function random() {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function quantileUsesFromHistogram(histogram: number[], runs: number, q: number) {
  if (runs <= 0) return 0;
  const threshold = clamp(Math.trunc(q * runs), 1, runs);
  let cumulative = 0;
  for (let uses = 0; uses < histogram.length; uses += 1) {
    cumulative += histogram[uses] ?? 0;
    if (cumulative >= threshold) return uses;
  }
  return Math.max(0, histogram.length - 1);
}

export function simulate(
  input: NormalizedSolverInput,
  actionFor: ActionFor,
  runs = 12000,
  seed = 20260505,
) {
  const random = makeRandom(seed);
  const totals: KitVector = { blue: 0, purple: 0, yellow: 0 };
  const hist: Record<Kit, number[]> = {
    blue: new Array(256).fill(0),
    purple: new Array(256).fill(0),
    yellow: new Array(256).fill(0),
  };
  let completed = 0;
  const finalRanks: number[] = [];

  for (let run = 0; run < runs; run += 1) {
    let state = normalizeState(input.start);
    let stock = { ...input.stockUses };
    const used: KitVector = { blue: 0, purple: 0, yellow: 0 };

    for (let step = 0; step < 1000; step += 1) {
      if (isTerminalNormalized(state)) {
        completed += 1;
        break;
      }
      if (isConvertStateNormalized(state)) {
        state = convertState();
        continue;
      }
      const kit = actionFor(state, stock);
      if (!kit || stock[kit] <= 0) break;
      stock = decrementStock(stock, kit);
      used[kit] += 10;
      const edge = transitionNormalized(state, kit);
      state = random() < edge.probability ? edge.success : edge.fail;
    }

    for (const kit of KIT_ORDER) {
      totals[kit] += used[kit];
      const bucket = Math.min(255, Math.floor(used[kit] / 10));
      hist[kit][bucket] = (hist[kit][bucket] ?? 0) + 1;
    }
    finalRanks.push(stageRank(state));
  }

  const kitQuantiles = (kit: Kit) => ({
    p50: quantileUsesFromHistogram(hist[kit], runs, 0.5) * 10,
    p90: quantileUsesFromHistogram(hist[kit], runs, 0.9) * 10,
    p95: quantileUsesFromHistogram(hist[kit], runs, 0.95) * 10,
  });

  return {
    runs,
    completed,
    successProbability: runs > 0 ? completed / runs : 0,
    vector: {
      blue: runs > 0 ? totals.blue / runs : 0,
      purple: runs > 0 ? totals.purple / runs : 0,
      yellow: runs > 0 ? totals.yellow / runs : 0,
    },
    quantiles: {
      blue: kitQuantiles("blue"),
      purple: kitQuantiles("purple"),
      yellow: kitQuantiles("yellow"),
    },
    depletion: runs > 0 ? (runs - completed) / runs : 0,
    stageReach: makeStageReachDistribution(finalRanks, runs),
  };
}
