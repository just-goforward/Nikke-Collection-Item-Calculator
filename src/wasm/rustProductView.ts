import { availabilityCostScore, legacySupplyCostScore } from "../solver/cost";
import {
  clamp,
  convertState,
  decrementStock,
  stateText as describeState,
  isConvertStateNormalized as isConvertState,
  isTerminalNormalized as isTerminal,
  normalizeState,
  pressureScore,
  round,
  totalKits,
  transition,
} from "../solver/domain";
import { makeStageReachDistribution, stageRank } from "../solver/stageReach";
import type { CollectionState, Kit, Stock } from "../types";
import type { RustProductInput } from "./rustProductInput";
import type { RustPhase2Candidate } from "./rustTypes";

const KIT_ORDER: Kit[] = ["blue", "purple", "yellow"];
const STRICT_EPSILON = 1e-12;

export type RustActionLookup = (state: CollectionState, stockUses: Stock) => Kit | null;

function comparePhase2Candidates(a: RustPhase2Candidate, b: RustPhase2Candidate) {
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
  if (a.eligible && b.eligible && Math.abs(a.resourceCost - b.resourceCost) > STRICT_EPSILON) {
    return a.resourceCost - b.resourceCost;
  }
  if (Math.abs(a.successProbability - b.successProbability) > STRICT_EPSILON) {
    return b.successProbability - a.successProbability;
  }
  if (Math.abs(a.resourceCost - b.resourceCost) > STRICT_EPSILON) {
    return a.resourceCost - b.resourceCost;
  }
  const totalDiff = totalKits(a.vector) - totalKits(b.vector);
  if (Math.abs(totalDiff) > STRICT_EPSILON) return totalDiff;
  return KIT_ORDER.indexOf(a.firstAction) - KIT_ORDER.indexOf(b.firstAction);
}

export function buildPhase2TopCandidates(
  input: RustProductInput,
  candidates: RustPhase2Candidate[],
  actionFor: RustActionLookup,
  name = "Rust phase2",
) {
  return [...candidates].sort(comparePhase2Candidates).map((candidate) => {
    const firstProbability = transition(input.start, candidate.firstAction).probability;
    const totalExpectedKits = totalKits(candidate.vector);
    const pressure = pressureScore(candidate.vector, input.stockUses);
    const legacySupplyCost = legacySupplyCostScore(candidate.vector);
    const availabilityCost = availabilityCostScore(candidate.vector, input.stock);
    const vector = Object.fromEntries(
      KIT_ORDER.map((kit) => [kit, round(candidate.vector[kit], 4)]),
    ) as Stock;
    return {
      name,
      firstAction: candidate.firstAction,
      firstProbability,
      run: buildRecommendedRunForKit(input, actionFor, candidate.firstAction),
      vector,
      totalKits: round(totalExpectedKits, 4),
      successProbability: round(candidate.successProbability, 8),
      probabilityGap: round(candidate.probabilityGap, 8),
      pressure: round(pressure, 8),
      supplyCost: round(legacySupplyCost, 8),
      availabilityCost: round(availabilityCost, 8),
      legacySupplyCost: round(legacySupplyCost, 8),
      resourceCost: round(candidate.resourceCost, 8),
    };
  });
}

function makeRandom(seed: number) {
  let value = seed >>> 0;
  return function random() {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

export function buildRecommendedRunForKit(
  input: RustProductInput,
  actionFor: RustActionLookup,
  kit: Kit | null,
  limit = 100,
) {
  let state = normalizeState(input.start);
  let stock = { ...input.stockUses };
  if (!kit || stock[kit] <= 0) return null;

  const firstEdge = transition(state, kit);
  const successTarget = firstEdge.success;
  let count = 0;
  let noGreatSuccessProbability = 1;

  while (count < limit && !isTerminal(state) && !isConvertState(state) && stock[kit] > 0) {
    if (count > 0) {
      const nextKit = actionFor(state, stock);
      if (nextKit !== kit) break;
    }
    const edge = transition(state, kit);
    if (edge.success.grade !== successTarget.grade || edge.success.level !== successTarget.level) {
      break;
    }
    count += 1;
    noGreatSuccessProbability *= 1 - edge.probability;
    stock = decrementStock(stock, kit);
    const fail = edge.fail;
    const leveledUp = fail.grade !== state.grade || fail.level !== state.level;
    state = fail;
    if (leveledUp) break;
  }

  return {
    kit,
    count,
    success: successTarget,
    fail: state,
    greatSuccessProbability: 1 - noGreatSuccessProbability,
    noGreatSuccessProbability,
  };
}

export function buildRecommendedRun(input: RustProductInput, actionFor: RustActionLookup) {
  const kit = actionFor(normalizeState(input.start), { ...input.stockUses });
  return buildRecommendedRunForKit(input, actionFor, kit);
}

export function buildFailureRoute(input: RustProductInput, actionFor: RustActionLookup, limit = 8) {
  const route = [];
  let state = normalizeState(input.start);
  let stock = { ...input.stockUses };

  for (let index = 0; index < limit; index += 1) {
    if (isTerminal(state)) break;
    if (isConvertState(state)) {
      const converted = convertState();
      route.push({
        state: describeState(state),
        kit: "convert",
        probability: 1,
        success: describeState(converted),
        fail: describeState(converted),
        stockBefore: { ...stock },
      });
      state = converted;
      continue;
    }
    const kit = actionFor(state, stock);
    if (!kit || stock[kit] <= 0) break;
    const edge = transition(state, kit);
    route.push({
      state: describeState(state),
      kit,
      probability: edge.probability,
      success: describeState(edge.success),
      fail: describeState(edge.fail),
      stockBefore: { ...stock },
    });
    stock = decrementStock(stock, kit);
    state = edge.fail;
  }

  return route;
}

export function buildFailureRouteWithFirstKit(
  input: RustProductInput,
  actionFor: RustActionLookup,
  firstKit: Kit,
  limit = 8,
) {
  let first = true;
  return buildFailureRoute(
    input,
    (state, stockUses) => {
      if (first) {
        first = false;
        return firstKit;
      }
      return actionFor(state, stockUses);
    },
    limit,
  );
}

export function simulate(
  input: RustProductInput,
  actionFor: RustActionLookup,
  runs = 12000,
  seed = 20260505,
) {
  const random = makeRandom(seed);
  const totals: Stock = { blue: 0, purple: 0, yellow: 0 };
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
    const used: Stock = { blue: 0, purple: 0, yellow: 0 };

    for (let step = 0; step < 1000; step += 1) {
      if (isTerminal(state)) {
        completed += 1;
        break;
      }
      if (isConvertState(state)) {
        state = convertState();
        continue;
      }
      const kit = actionFor(state, stock);
      if (!kit || stock[kit] <= 0) break;
      stock = decrementStock(stock, kit);
      used[kit] += 10;
      const edge = transition(state, kit);
      state = random() < edge.probability ? edge.success : edge.fail;
    }

    for (const kit of KIT_ORDER) {
      totals[kit] += used[kit];
      const bucket = Math.min(255, Math.floor(used[kit] / 10));
      hist[kit][bucket] = (hist[kit][bucket] ?? 0) + 1;
    }
    finalRanks.push(stageRank(state));
  }

  const quantileUses = (kit: Kit, q: number) => {
    if (runs <= 0) return 0;
    const threshold = clamp(Math.trunc(q * runs), 1, runs);
    let cumulative = 0;
    for (let uses = 0; uses < hist[kit].length; uses += 1) {
      cumulative += hist[kit][uses] ?? 0;
      if (cumulative >= threshold) return uses;
    }
    return Math.max(0, hist[kit].length - 1);
  };
  const quantiles = Object.fromEntries(
    KIT_ORDER.map((kit) => [
      kit,
      {
        p50: quantileUses(kit, 0.5) * 10,
        p90: quantileUses(kit, 0.9) * 10,
        p95: quantileUses(kit, 0.95) * 10,
      },
    ]),
  ) as Record<Kit, { p50: number; p90: number; p95: number }>;

  return {
    runs,
    completed,
    successProbability: runs > 0 ? completed / runs : 0,
    vector: {
      blue: runs > 0 ? totals.blue / runs : 0,
      purple: runs > 0 ? totals.purple / runs : 0,
      yellow: runs > 0 ? totals.yellow / runs : 0,
    },
    quantiles,
    depletion: runs > 0 ? (runs - completed) / runs : 0,
    stageReach: makeStageReachDistribution(finalRanks, runs),
  };
}
