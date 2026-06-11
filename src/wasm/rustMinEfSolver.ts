import {
  convertState,
  describeState,
  EXPECTED_28_DAY_GAIN,
  FIXED_REQUIRED_EXP,
  MAX_RELEVANT_USES,
  round,
  SUPPLY_AVAILABILITY_PARAMS,
  transition,
} from "../solver";
import type { CollectionState, Kit, SolverInput, Stock } from "../types";
import {
  isMemoFull,
  loadRustMinEfSolver,
  loadRustPhase2Solver,
  type RustMinEfSolver,
  type RustPairedExpectedCostEstimate,
  type RustPhase2Candidate,
  type RustPhase2Solver,
  type RustRerankedCandidate,
  type RustRerankResult,
} from "./rustCore";

const KIT_ORDER: Kit[] = ["blue", "purple", "yellow"];
const STRICT_EPSILON = 1e-12;
const HORIZON_FACTOR = 0.75;
const NORM_POWER = 3;
const TOLERANCE = 0;
const SOLVER_VERSION = "phase3_rust_min_ef_staging";
const PHASE2_SOLVER_VERSION = "phase2_availability_h075_tau0_p3_rust";
const RERANK_SOLVER_VERSION =
  "phase2_availability_h075_tau0_p3_rust_rerank_adaptive90_m025_confirm_staging";
const RERANK_QUICK_RUNS = 512;
const RERANK_MAX_RUNS = 2048;
const RERANK_GATE_Z = 1.645;
const RERANK_QUICK_ACCEPT_MARGIN = -0.001;
const RERANK_FULL_ACCEPT_MARGIN = -0.00025;
const RERANK_SEED = 20260509;
const RERANK_HELD_OUT_SEED = 20260510;

type AdaptiveRerankDecision = {
  rerank: RustRerankResult;
  rawSelected: RustRerankedCandidate;
  selected: RustRerankedCandidate;
  gatePair: RustPairedExpectedCostEstimate | null;
  gatePass: boolean;
  gateRuns: number;
  gateUpperBound: number | null;
};

type NormalizedInput = SolverInput & {
  actualStockUses: Stock;
  stockUses: Stock;
  requiredExp: typeof FIXED_REQUIRED_EXP;
};

let solverPromise: Promise<RustMinEfSolver> | null = null;
let phase2SolverPromise: Promise<RustPhase2Solver> | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeState(state?: Partial<CollectionState> | null): CollectionState {
  const grade = state?.grade === "SR" ? "SR" : "R";
  const rawLevel = Number(state?.level);
  const level = Number.isFinite(rawLevel) ? Math.max(0, Math.floor(rawLevel)) : 0;
  const exp = Math.max(0, Math.floor(Number(state?.exp) || 0));
  if (level >= 15) return { grade, level: 15, exp: 0 };
  return { grade, level: clamp(level, 0, 14), exp };
}

function isTerminal(state: CollectionState) {
  return state.grade === "SR" && state.level >= 15;
}

function isConvertState(state: CollectionState) {
  return state.grade === "R" && state.level >= 15;
}

function normalizeStock(stock?: Partial<Stock> | null): Stock {
  return {
    blue: Math.max(0, Math.floor(Number(stock?.blue) || 0)),
    purple: Math.max(0, Math.floor(Number(stock?.purple) || 0)),
    yellow: Math.max(0, Math.floor(Number(stock?.yellow) || 0)),
  };
}

function stockToUses(stock: Stock): Stock {
  return {
    blue: Math.floor(stock.blue / 10),
    purple: Math.floor(stock.purple / 10),
    yellow: Math.floor(stock.yellow / 10),
  };
}

function normalizeInput(input: SolverInput): NormalizedInput {
  const grade = input.start?.grade === "SR" ? "SR" : "R";
  const required = FIXED_REQUIRED_EXP[grade];
  const exp = clamp(Math.floor((Number(input.start?.exp) || 0) / 100) * 100, 0, required - 100);
  const stock = normalizeStock(input.stock || {});
  const actualStockUses = stockToUses(stock);
  return {
    start: normalizeState({
      grade,
      level: input.start ? input.start.level : 0,
      exp,
    }),
    strategy: "supply",
    stock,
    actualStockUses,
    stockUses: {
      blue: Math.min(actualStockUses.blue, MAX_RELEVANT_USES.blue),
      purple: Math.min(actualStockUses.purple, MAX_RELEVANT_USES.purple),
      yellow: Math.min(actualStockUses.yellow, MAX_RELEVANT_USES.yellow),
    },
    requiredExp: FIXED_REQUIRED_EXP,
    monteCarloRuns: input.monteCarloRuns,
    monteCarloSeed: input.monteCarloSeed,
  };
}

function decrementStock(stock: Stock, kit: Kit): Stock {
  return {
    blue: stock.blue - (kit === "blue" ? 1 : 0),
    purple: stock.purple - (kit === "purple" ? 1 : 0),
    yellow: stock.yellow - (kit === "yellow" ? 1 : 0),
  };
}

function totalKits(vector: Stock) {
  return KIT_ORDER.reduce((sum, kit) => sum + vector[kit], 0);
}

function pressureScore(vector: Stock, initialUses: Stock) {
  return KIT_ORDER.reduce((sum, kit) => {
    const base = Math.max(1, initialUses[kit]);
    return sum + vector[kit] / 10 / base;
  }, 0);
}

function legacySupplyCostScore(vector: Stock) {
  return KIT_ORDER.reduce((sum, kit) => sum + vector[kit] / EXPECTED_28_DAY_GAIN[kit], 0);
}

function availabilityRatio(consumption: number, availability: number) {
  if (availability > 0) return consumption / availability;
  return consumption > STRICT_EPSILON ? Number.POSITIVE_INFINITY : 0;
}

function availabilityCostScore(vector: Stock, stockPieces: Stock) {
  const ratios = KIT_ORDER.map((kit) =>
    availabilityRatio(vector[kit], stockPieces[kit] + HORIZON_FACTOR * EXPECTED_28_DAY_GAIN[kit]),
  );
  return ratios.reduce((sum, ratio) => sum + ratio ** NORM_POWER, 0) ** (1 / NORM_POWER);
}

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

function buildPhase2TopCandidates(
  input: NormalizedInput,
  candidates: RustPhase2Candidate[],
  actionFor: (state: CollectionState, stockUses: Stock) => Kit | null,
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

function actionFactory(solver: RustMinEfSolver) {
  // RustMinEfSolver is research-only. Its action lookup intentionally keeps the historical
  // build-once contract; product hardening is scoped to RustPhase2Solver.
  return (state: CollectionState, stockUses: Stock): Kit | null => {
    if (isTerminal(state) || isConvertState(state)) return null;
    return solver.actionAt(state, stockUses);
  };
}

function buildRecommendedRunForKit(
  input: NormalizedInput,
  actionFor: (state: CollectionState, stockUses: Stock) => Kit | null,
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

function buildRecommendedRun(
  input: NormalizedInput,
  actionFor: (state: CollectionState, stockUses: Stock) => Kit | null,
) {
  const kit = actionFor(normalizeState(input.start), { ...input.stockUses });
  return buildRecommendedRunForKit(input, actionFor, kit);
}

function buildFailureRoute(
  input: NormalizedInput,
  actionFor: (state: CollectionState, stockUses: Stock) => Kit | null,
  limit = 8,
) {
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

function buildFailureRouteWithFirstKit(
  input: NormalizedInput,
  actionFor: (state: CollectionState, stockUses: Stock) => Kit | null,
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

function simulate(
  input: NormalizedInput,
  actionFor: (state: CollectionState, stockUses: Stock) => Kit | null,
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
      hist[kit][Math.min(255, Math.floor(used[kit] / 10))] += 1;
    }
  }

  const quantileUses = (kit: Kit, q: number) => {
    if (runs <= 0) return 0;
    const threshold = clamp(Math.trunc(q * runs), 1, runs);
    let cumulative = 0;
    for (let uses = 0; uses < hist[kit].length; uses += 1) {
      cumulative += hist[kit][uses];
      if (cumulative >= threshold) return uses;
    }
    return hist[kit].length - 1;
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
  };
}

async function getSolver(wasmUrl: string) {
  solverPromise ??= loadRustMinEfSolver(wasmUrl);
  return solverPromise;
}

async function getPhase2Solver(wasmUrl: string) {
  phase2SolverPromise ??= loadRustPhase2Solver(wasmUrl);
  return phase2SolverPromise;
}

function baselineRerankCandidate(
  solver: RustPhase2Solver,
  rerank: RustRerankResult,
  input: NormalizedInput,
): RustRerankedCandidate | null {
  const firstAction = rerank.baseline.firstAction;
  if (!firstAction) return null;
  const existing = rerank.candidates.find((candidate) => candidate.firstAction === firstAction);
  if (existing) return existing;
  const estimate = solver.estimateExpectedCostAfterFirstActionFromCurrent(
    input.start,
    input.stock,
    firstAction,
    RERANK_QUICK_RUNS,
    RERANK_SEED,
    HORIZON_FACTOR,
    NORM_POWER,
  );
  return {
    firstAction,
    successProbability: rerank.baseline.successProbability,
    maxSuccessProbability: rerank.baseline.maxSuccessProbability,
    probabilityGap: Math.max(
      0,
      rerank.baseline.maxSuccessProbability - rerank.baseline.successProbability,
    ),
    vector: rerank.baseline.vector,
    resourceCost: estimate.expectedCost,
    eligible: true,
    expectedCost: estimate.expectedCost,
    completionRate: estimate.completionRate,
  };
}

function selectAdaptiveRerankDecision(
  solver: RustPhase2Solver,
  input: NormalizedInput,
): AdaptiveRerankDecision | null {
  const rerank = solver.selectFirstActionByExpectedCost(
    input.start,
    input.stock,
    RERANK_QUICK_RUNS,
    RERANK_SEED,
    HORIZON_FACTOR,
    NORM_POWER,
    TOLERANCE,
  );
  const rawSelected = rerank?.selected;
  const baselineAction = rerank?.baseline.firstAction;
  if (!rerank || !rawSelected?.firstAction || !baselineAction) return null;
  if (baselineAction === rawSelected.firstAction) {
    return {
      rerank,
      rawSelected,
      selected: rawSelected,
      gatePair: null,
      gatePass: true,
      gateRuns: 0,
      gateUpperBound: null,
    };
  }
  const quickGatePair = solver.estimateExpectedCostPairFromCurrent(
    input.start,
    input.stock,
    baselineAction,
    rawSelected.firstAction,
    RERANK_QUICK_RUNS,
    RERANK_HELD_OUT_SEED,
    HORIZON_FACTOR,
    NORM_POWER,
  );
  const quickUpperBound = quickGatePair.meanDelta + RERANK_GATE_Z * quickGatePair.standardError;
  if (quickUpperBound < RERANK_QUICK_ACCEPT_MARGIN) {
    return {
      rerank,
      rawSelected,
      selected: rawSelected,
      gatePair: quickGatePair,
      gatePass: true,
      gateRuns: RERANK_QUICK_RUNS,
      gateUpperBound: quickUpperBound,
    };
  }
  const quickLowerBound = quickGatePair.meanDelta - RERANK_GATE_Z * quickGatePair.standardError;
  const fullGatePair =
    quickLowerBound >= 0
      ? quickGatePair
      : solver.estimateExpectedCostPairFromCurrent(
          input.start,
          input.stock,
          baselineAction,
          rawSelected.firstAction,
          RERANK_MAX_RUNS,
          RERANK_HELD_OUT_SEED,
          HORIZON_FACTOR,
          NORM_POWER,
        );
  const gateUpperBound = fullGatePair.meanDelta + RERANK_GATE_Z * fullGatePair.standardError;
  const gatePass = gateUpperBound < RERANK_FULL_ACCEPT_MARGIN;
  if (gatePass) {
    return {
      rerank,
      rawSelected,
      selected: rawSelected,
      gatePair: fullGatePair,
      gatePass,
      gateRuns: fullGatePair.runs,
      gateUpperBound,
    };
  }
  const baseline = baselineRerankCandidate(solver, rerank, input);
  if (!baseline) return null;
  return {
    rerank,
    rawSelected,
    selected: baseline,
    gatePair: fullGatePair,
    gatePass,
    gateRuns: fullGatePair.runs,
    gateUpperBound,
  };
}

export async function solveRustMinEfProduct(
  input: SolverInput,
  wasmUrl: string,
  progress?: (progress: { phase: string; scanned?: number; total?: number | null }) => void,
) {
  const normalizedInput = normalizeInput(input);
  if (progress) progress({ phase: "build", scanned: 0, total: 1 });

  if (isTerminal(normalizedInput.start)) {
    return {
      terminal: true,
      input: normalizedInput,
      message: "이미 SR 15레벨입니다.",
    };
  }

  if (isConvertState(normalizedInput.start)) {
    return {
      possible: true,
      convertOnly: true,
      input: normalizedInput,
      best: {
        name: "등급 전환",
        firstAction: "convert",
        firstProbability: 1,
        success: convertState(),
        fail: convertState(),
        vector: { blue: 0, purple: 0, yellow: 0 },
        totalKits: 0,
        successProbability: 1,
        pressure: 0,
      },
      route: [],
      monteCarlo: {
        runs: 0,
        completed: 0,
        successProbability: 1,
        vector: { blue: 0, purple: 0, yellow: 0 },
      },
      stats: { states: 0, exact: true, tolerance: 0, iterations: 0, solverVersion: SOLVER_VERSION },
      topCandidates: [],
    };
  }

  const totalUses = KIT_ORDER.reduce((sum, kit) => sum + normalizedInput.stockUses[kit], 0);
  if (totalUses <= 0) {
    return {
      possible: false,
      input: normalizedInput,
      message: "사용 가능한 키트가 없습니다. 각 키트는 10개 단위로만 사용할 수 있습니다.",
    };
  }
  try {
    const solver = await getSolver(wasmUrl);
    const root = solver.solveRoot(
      normalizedInput.start,
      normalizedInput.stock,
      HORIZON_FACTOR,
      NORM_POWER,
      TOLERANCE,
    );
    const candidates = solver.rootCandidates(
      normalizedInput.start,
      normalizedInput.stock,
      HORIZON_FACTOR,
      NORM_POWER,
      TOLERANCE,
    );
    if (!root.firstAction) {
      return {
        possible: false,
        input: normalizedInput,
        message: "현재 보유 키트로 가능한 행동이 없습니다.",
      };
    }

    const actionFor = actionFactory(solver);
    const topCandidates = buildPhase2TopCandidates(
      normalizedInput,
      candidates,
      actionFor,
      "Rust min E[f]",
    );
    const run = buildRecommendedRun(normalizedInput, actionFor);
    const route = buildFailureRoute(normalizedInput, actionFor);
    const edge = transition(normalizedInput.start, root.firstAction);
    const totalExpectedKits = totalKits(root.vector);
    const pressure = pressureScore(root.vector, normalizedInput.stockUses);
    const legacySupplyCost = legacySupplyCostScore(root.vector);
    const availabilityCost = availabilityCostScore(root.vector, normalizedInput.stock);
    const monteCarloRuns = Math.max(0, Math.floor(Number(input?.monteCarloRuns) || 0));
    const monteCarloSeed = Math.max(0, Math.floor(Number(input?.monteCarloSeed) || 20260505));
    const monteCarlo =
      monteCarloRuns > 0
        ? simulate(normalizedInput, actionFor, monteCarloRuns, monteCarloSeed)
        : {
            runs: 0,
            completed: 0,
            successProbability: root.successProbability,
            vector: { blue: 0, purple: 0, yellow: 0 },
          };

    if (progress) progress({ phase: "done", scanned: 1, total: 1 });

    return {
      possible: true,
      terminal: false,
      input: normalizedInput,
      candidateCount: topCandidates.length,
      best: {
        name: "Rust min E[f]",
        firstAction: root.firstAction,
        firstProbability: edge.probability,
        run,
        success: edge.success,
        fail: edge.fail,
        vector: root.vector,
        totalKits: totalExpectedKits,
        successProbability: root.successProbability,
        maxSuccessProbability: root.maxSuccessProbability,
        probabilityGap: Math.max(0, root.maxSuccessProbability - root.successProbability),
        pressure,
        supplyCost: legacySupplyCost,
        availabilityCost,
        legacySupplyCost,
        resourceCost: root.expectedCost,
      },
      route,
      monteCarlo,
      stats: {
        states: 0,
        exact: true,
        tolerance: 0,
        probabilityTolerance: TOLERANCE,
        maxSuccessProbability: root.maxSuccessProbability,
        strategy: "supply",
        solverBackend: "rust-min-ef",
        solverVersion: SOLVER_VERSION,
        solverPhase: "phase3",
        supplyAvailability: SUPPLY_AVAILABILITY_PARAMS,
        rustMinEf: {
          horizonFactor: HORIZON_FACTOR,
          normPower: NORM_POWER,
          expectedCost: root.expectedCost,
        },
        iterations: 0,
      },
      topCandidates,
    };
  } catch (error) {
    if (!isMemoFull(error)) throw error;
    if (progress) progress({ phase: "fallback-phase2", scanned: 0, total: 1 });
    return solveRustPhase2(input, wasmUrl, progress);
  }
}

export async function solveRustMinEf(
  input: SolverInput,
  wasmUrl: string,
  progress?: (progress: { phase: string; scanned?: number; total?: number | null }) => void,
) {
  return solveRustMinEfProduct(input, wasmUrl, progress);
}

export async function solveRustPhase2(
  input: SolverInput,
  wasmUrl: string,
  progress?: (progress: { phase: string; scanned?: number; total?: number | null }) => void,
) {
  const normalizedInput = normalizeInput(input);
  if (progress) progress({ phase: "build", scanned: 0, total: 1 });

  if (isTerminal(normalizedInput.start)) {
    return {
      terminal: true,
      input: normalizedInput,
      message: "이미 SR 15레벨입니다.",
    };
  }

  if (isConvertState(normalizedInput.start)) {
    return {
      possible: true,
      convertOnly: true,
      input: normalizedInput,
      best: {
        name: "등급 전환",
        firstAction: "convert",
        firstProbability: 1,
        success: convertState(),
        fail: convertState(),
        vector: { blue: 0, purple: 0, yellow: 0 },
        totalKits: 0,
        successProbability: 1,
        pressure: 0,
      },
      route: [],
      monteCarlo: {
        runs: 0,
        completed: 0,
        successProbability: 1,
        vector: { blue: 0, purple: 0, yellow: 0 },
      },
      stats: {
        states: 0,
        exact: true,
        tolerance: 0,
        iterations: 0,
        solverVersion: PHASE2_SOLVER_VERSION,
      },
      topCandidates: [],
    };
  }

  const totalUses = KIT_ORDER.reduce((sum, kit) => sum + normalizedInput.stockUses[kit], 0);
  if (totalUses <= 0) {
    return {
      possible: false,
      input: normalizedInput,
      message: "사용 가능한 키트가 없습니다. 각 키트는 10개 단위로만 사용할 수 있습니다.",
    };
  }

  const solver = await getPhase2Solver(wasmUrl);
  const policy = solver.buildPolicy(
    normalizedInput.start,
    normalizedInput.stock,
    HORIZON_FACTOR,
    NORM_POWER,
    TOLERANCE,
  );
  const root = policy.root;
  if (!root.firstAction) {
    return {
      possible: false,
      input: normalizedInput,
      message: "현재 보유 키트로 가능한 행동이 없습니다.",
    };
  }

  const actionFor = (state: CollectionState, stockUses: Stock) => {
    if (isTerminal(state) || isConvertState(state)) return null;
    return policy.actionAt(state, stockUses);
  };
  const topCandidates = buildPhase2TopCandidates(normalizedInput, policy.candidates, actionFor);
  const run = buildRecommendedRun(normalizedInput, actionFor);
  const route = buildFailureRoute(normalizedInput, actionFor);
  const edge = transition(normalizedInput.start, root.firstAction);
  const totalExpectedKits = totalKits(root.vector);
  const pressure = pressureScore(root.vector, normalizedInput.stockUses);
  const legacySupplyCost = legacySupplyCostScore(root.vector);
  const availabilityCost = availabilityCostScore(root.vector, normalizedInput.stock);
  const monteCarloRuns = Math.max(0, Math.floor(Number(input?.monteCarloRuns) || 0));
  const monteCarloSeed = Math.max(0, Math.floor(Number(input?.monteCarloSeed) || 20260505));
  const monteCarlo =
    monteCarloRuns > 0
      ? solver.simulatePolicy(
          normalizedInput.start,
          normalizedInput.stock,
          monteCarloRuns,
          monteCarloSeed,
          HORIZON_FACTOR,
          NORM_POWER,
          TOLERANCE,
        )
      : {
          runs: 0,
          completed: 0,
          successProbability: root.successProbability,
          vector: { blue: 0, purple: 0, yellow: 0 },
        };

  if (progress) progress({ phase: "done", scanned: root.states, total: root.states });

  return {
    possible: true,
    terminal: false,
    input: normalizedInput,
    candidateCount: topCandidates.length,
    best: {
      name: "Rust phase2",
      firstAction: root.firstAction,
      firstProbability: edge.probability,
      run,
      success: edge.success,
      fail: edge.fail,
      vector: root.vector,
      totalKits: totalExpectedKits,
      successProbability: root.successProbability,
      maxSuccessProbability: root.maxSuccessProbability,
      probabilityGap: Math.max(0, root.maxSuccessProbability - root.successProbability),
      pressure,
      supplyCost: legacySupplyCost,
      availabilityCost,
      legacySupplyCost,
      resourceCost: availabilityCost,
    },
    route,
    monteCarlo,
    stats: {
      states: root.states,
      exact: true,
      tolerance: 0,
      probabilityTolerance: TOLERANCE,
      maxSuccessProbability: root.maxSuccessProbability,
      strategy: "supply",
      solverBackend: "rust-phase2",
      solverVersion: PHASE2_SOLVER_VERSION,
      solverPhase: "phase2",
      supplyAvailability: SUPPLY_AVAILABILITY_PARAMS,
      iterations: 0,
    },
    topCandidates,
  };
}

export async function solveRustPhase2Rerank(
  input: SolverInput,
  wasmUrl: string,
  progress?: (progress: { phase: string; scanned?: number; total?: number | null }) => void,
) {
  const normalizedInput = normalizeInput(input);
  if (progress) progress({ phase: "build", scanned: 0, total: 1 });

  if (isTerminal(normalizedInput.start)) {
    return {
      terminal: true,
      input: normalizedInput,
      message: "이미 SR 15레벨입니다.",
    };
  }

  if (isConvertState(normalizedInput.start)) {
    return {
      possible: true,
      convertOnly: true,
      input: normalizedInput,
      best: {
        name: "등급 전환",
        firstAction: "convert",
        firstProbability: 1,
        success: convertState(),
        fail: convertState(),
        vector: { blue: 0, purple: 0, yellow: 0 },
        totalKits: 0,
        successProbability: 1,
        pressure: 0,
      },
      route: [],
      monteCarlo: {
        runs: 0,
        completed: 0,
        successProbability: 1,
        vector: { blue: 0, purple: 0, yellow: 0 },
      },
      stats: {
        states: 0,
        exact: true,
        tolerance: 0,
        iterations: 0,
        solverVersion: RERANK_SOLVER_VERSION,
      },
      topCandidates: [],
    };
  }

  const totalUses = KIT_ORDER.reduce((sum, kit) => sum + normalizedInput.stockUses[kit], 0);
  if (totalUses <= 0) {
    return {
      possible: false,
      input: normalizedInput,
      message: "사용 가능한 키트가 없습니다. 각 키트는 10개 단위로만 사용할 수 있습니다.",
    };
  }

  const solver = await getPhase2Solver(wasmUrl);
  const decision = selectAdaptiveRerankDecision(solver, normalizedInput);
  const rerank = decision?.rerank;
  const baselineRoot = rerank?.baseline;
  const selected = decision?.selected;
  const rawSelected = decision?.rawSelected;
  if (!baselineRoot || !selected?.firstAction) {
    return {
      possible: false,
      input: normalizedInput,
      message: "현재 보유 키트로 가능한 행동이 없습니다.",
    };
  }
  const heldOut = solver.estimateExpectedCostAfterFirstActionFromCurrent(
    normalizedInput.start,
    normalizedInput.stock,
    selected.firstAction,
    RERANK_MAX_RUNS,
    RERANK_HELD_OUT_SEED,
    HORIZON_FACTOR,
    NORM_POWER,
  );
  const heldOutBaseline = baselineRoot.firstAction
    ? baselineRoot.firstAction === selected.firstAction
      ? heldOut
      : solver.estimateExpectedCostAfterFirstActionFromCurrent(
          normalizedInput.start,
          normalizedInput.stock,
          baselineRoot.firstAction,
          RERANK_MAX_RUNS,
          RERANK_HELD_OUT_SEED,
          HORIZON_FACTOR,
          NORM_POWER,
        )
    : null;

  const actionFor = (state: CollectionState, stockUses: Stock) => {
    if (isTerminal(state) || isConvertState(state)) return null;
    return rerank.policy.actionAt(state, stockUses);
  };
  const run = buildRecommendedRunForKit(normalizedInput, actionFor, selected.firstAction);
  const route = buildFailureRouteWithFirstKit(normalizedInput, actionFor, selected.firstAction);
  const edge = transition(normalizedInput.start, selected.firstAction);
  const totalExpectedKits = totalKits(selected.vector);
  const pressure = pressureScore(selected.vector, normalizedInput.stockUses);
  const legacySupplyCost = legacySupplyCostScore(selected.vector);
  const availabilityCost = availabilityCostScore(selected.vector, normalizedInput.stock);
  const monteCarloRuns = Math.max(0, Math.floor(Number(input?.monteCarloRuns) || 0));
  const monteCarloSeed = Math.max(0, Math.floor(Number(input?.monteCarloSeed) || 20260505));
  const monteCarlo =
    monteCarloRuns > 0
      ? solver.simulatePolicyAfterFirstAction(
          normalizedInput.start,
          normalizedInput.stock,
          selected.firstAction,
          monteCarloRuns,
          monteCarloSeed,
          HORIZON_FACTOR,
          NORM_POWER,
          TOLERANCE,
        )
      : {
          runs: 0,
          completed: 0,
          successProbability: selected.successProbability,
          vector: { blue: 0, purple: 0, yellow: 0 },
        };

  if (progress)
    progress({ phase: "done", scanned: baselineRoot.states, total: baselineRoot.states });

  const candidate = {
    name: "Rust phase2 rerank adaptive90 m0.00025 confirm",
    firstAction: selected.firstAction,
    firstProbability: edge.probability,
    run,
    vector: Object.fromEntries(KIT_ORDER.map((kit) => [kit, round(selected.vector[kit], 4)])),
    totalKits: round(totalExpectedKits, 4),
    successProbability: round(selected.successProbability, 8),
    probabilityGap: round(selected.probabilityGap, 8),
    pressure: round(pressure, 8),
    supplyCost: round(legacySupplyCost, 8),
    availabilityCost: round(availabilityCost, 8),
    legacySupplyCost: round(legacySupplyCost, 8),
    resourceCost: round(selected.expectedCost, 8),
    rerankExpectedCost: round(selected.expectedCost, 8),
    rerankCompletionRate: round(selected.completionRate, 8),
  };

  return {
    possible: true,
    terminal: false,
    input: normalizedInput,
    candidateCount: rerank?.candidates.length || 1,
    best: {
      name: "Rust phase2 rerank adaptive90 m0.00025 confirm",
      firstAction: selected.firstAction,
      firstProbability: edge.probability,
      run,
      success: edge.success,
      fail: edge.fail,
      vector: selected.vector,
      totalKits: totalExpectedKits,
      successProbability: selected.successProbability,
      maxSuccessProbability: selected.maxSuccessProbability,
      probabilityGap: selected.probabilityGap,
      pressure,
      supplyCost: legacySupplyCost,
      availabilityCost,
      legacySupplyCost,
      resourceCost: selected.expectedCost,
    },
    route,
    monteCarlo,
    stats: {
      states: baselineRoot.states,
      exact: true,
      tolerance: 0,
      probabilityTolerance: TOLERANCE,
      maxSuccessProbability: selected.maxSuccessProbability,
      strategy: "supply",
      solverBackend: "rust-phase2-rerank",
      solverVersion: RERANK_SOLVER_VERSION,
      solverPhase: "phase2-rerank",
      supplyAvailability: SUPPLY_AVAILABILITY_PARAMS,
      rustRerank: {
        runs: RERANK_QUICK_RUNS,
        maxRuns: RERANK_MAX_RUNS,
        seed: RERANK_SEED,
        gate: "adaptive90",
        gateZ: RERANK_GATE_Z,
        gateQuickAcceptMargin: RERANK_QUICK_ACCEPT_MARGIN,
        gateFullAcceptMargin: RERANK_FULL_ACCEPT_MARGIN,
        gateRuns: decision?.gateRuns ?? null,
        gateSeed: RERANK_HELD_OUT_SEED,
        gatePass: decision?.gatePass ?? null,
        gateMeanDelta: decision?.gatePair?.meanDelta ?? null,
        gateStandardError: decision?.gatePair?.standardError ?? null,
        gateUpper95: decision?.gatePair?.upper95 ?? null,
        gateUpperBound: decision?.gateUpperBound ?? null,
        gateCorrelation: decision?.gatePair?.correlation ?? null,
        rawSelectedFirstAction: rawSelected?.firstAction ?? null,
        rawExpectedCost: rawSelected?.expectedCost ?? null,
        rawCompletionRate: rawSelected?.completionRate ?? null,
        expectedCost: selected.expectedCost,
        completionRate: selected.completionRate,
        heldOutSeed: RERANK_HELD_OUT_SEED,
        heldOutExpectedCost: heldOut.expectedCost,
        heldOutCompletionRate: heldOut.completionRate,
        heldOutBaselineExpectedCost: heldOutBaseline?.expectedCost ?? null,
        heldOutBaselineCompletionRate: heldOutBaseline?.completionRate ?? null,
        heldOutDeltaVsBaseline:
          heldOutBaseline && Number.isFinite(heldOutBaseline.expectedCost)
            ? heldOut.expectedCost - heldOutBaseline.expectedCost
            : null,
        heldOutBeatsBaseline:
          heldOutBaseline && Number.isFinite(heldOutBaseline.expectedCost)
            ? heldOut.expectedCost <= heldOutBaseline.expectedCost + STRICT_EPSILON
            : null,
        baselineFirstAction: baselineRoot.firstAction,
        baselineSuccessProbability: baselineRoot.successProbability,
      },
      iterations: 0,
    },
    topCandidates: [candidate],
  };
}

export async function validateRustMinEf(
  input: SolverInput,
  wasmUrl: string,
  runs: number,
  seed = 20260505,
) {
  const normalizedInput = normalizeInput(input);
  try {
    const solver = await getSolver(wasmUrl);
    solver.solveRoot(
      normalizedInput.start,
      normalizedInput.stock,
      HORIZON_FACTOR,
      NORM_POWER,
      TOLERANCE,
    );
    return simulate(normalizedInput, actionFactory(solver), runs, seed);
  } catch (error) {
    if (!isMemoFull(error)) throw error;
    return validateRustPhase2(input, wasmUrl, runs, seed);
  }
}

export async function validateRustPhase2(
  input: SolverInput,
  wasmUrl: string,
  runs: number,
  seed = 20260505,
) {
  const normalizedInput = normalizeInput(input);
  const solver = await getPhase2Solver(wasmUrl);
  solver.solveRoot(
    normalizedInput.start,
    normalizedInput.stock,
    HORIZON_FACTOR,
    NORM_POWER,
    TOLERANCE,
  );
  return solver.simulatePolicy(
    normalizedInput.start,
    normalizedInput.stock,
    runs,
    seed,
    HORIZON_FACTOR,
    NORM_POWER,
    TOLERANCE,
  );
}

export async function validateRustPhase2Rerank(
  input: SolverInput,
  wasmUrl: string,
  runs: number,
  seed = 20260505,
) {
  const normalizedInput = normalizeInput(input);
  const solver = await getPhase2Solver(wasmUrl);
  const decision = selectAdaptiveRerankDecision(solver, normalizedInput);
  const firstKit = decision?.selected.firstAction;
  if (!firstKit) {
    return {
      runs,
      completed: 0,
      successProbability: 0,
      vector: { blue: 0, purple: 0, yellow: 0 },
    };
  }
  return solver.simulatePolicyAfterFirstAction(
    normalizedInput.start,
    normalizedInput.stock,
    firstKit,
    runs,
    seed,
    HORIZON_FACTOR,
    NORM_POWER,
    TOLERANCE,
  );
}
