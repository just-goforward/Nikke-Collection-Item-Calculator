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
import { loadRustMinEfSolver, type RustMinEfSolver } from "./rustCore";

const KIT_ORDER: Kit[] = ["blue", "purple", "yellow"];
const STRICT_EPSILON = 1e-12;
const HORIZON_FACTOR = 0.75;
const NORM_POWER = 3;
const TOLERANCE = 0;
const SOLVER_VERSION = "phase3_rust_min_ef_staging";
const MAX_RUST_MIN_EF_STOCK_VOLUME = 10_000;

type NormalizedInput = SolverInput & {
  actualStockUses: Stock;
  stockUses: Stock;
  requiredExp: typeof FIXED_REQUIRED_EXP;
};

let solverPromise: Promise<RustMinEfSolver> | null = null;

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

function rustMinEfStockVolume(stockUses: Stock) {
  return (stockUses.blue + 1) * (stockUses.purple + 1) * (stockUses.yellow + 1);
}

function assertRustMinEfInputSupported(input: NormalizedInput) {
  const volume = rustMinEfStockVolume(input.stockUses);
  if (volume <= MAX_RUST_MIN_EF_STOCK_VOLUME) return;

  throw new Error(
    [
      "Rust min E[f] staging solver is currently limited to smaller inventory states.",
      `State volume ${volume.toLocaleString("en-US")} exceeds ${MAX_RUST_MIN_EF_STOCK_VOLUME.toLocaleString("en-US")}.`,
      "Use the default JS solver for this input, or test Rust mode with lower kit counts until the Rust kernel gets dynamic stock capping.",
    ].join(" "),
  );
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

function makeRandom(seed: number) {
  let value = seed >>> 0;
  return function random() {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function actionFactory(solver: RustMinEfSolver) {
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
  limit = 100,
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

function simulate(
  input: NormalizedInput,
  actionFor: (state: CollectionState, stockUses: Stock) => Kit | null,
  runs = 12000,
  seed = 20260505,
) {
  const random = makeRandom(seed);
  const totals: Stock = { blue: 0, purple: 0, yellow: 0 };
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

    for (const kit of KIT_ORDER) totals[kit] += used[kit];
  }

  return {
    runs,
    completed,
    successProbability: runs > 0 ? completed / runs : 0,
    vector: {
      blue: runs > 0 ? totals.blue / runs : 0,
      purple: runs > 0 ? totals.purple / runs : 0,
      yellow: runs > 0 ? totals.yellow / runs : 0,
    },
  };
}

async function getSolver(wasmUrl: string) {
  solverPromise ??= loadRustMinEfSolver(wasmUrl);
  return solverPromise;
}

export async function solveRustMinEf(
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
      message: "?대? SR 15?덈꺼?낅땲??",
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
  assertRustMinEfInputSupported(normalizedInput);

  const solver = await getSolver(wasmUrl);
  const root = solver.solveRoot(
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

  const candidate = {
    name: "Rust min E[f]",
    firstAction: root.firstAction,
    firstProbability: edge.probability,
    run,
    vector: Object.fromEntries(KIT_ORDER.map((kit) => [kit, round(root.vector[kit], 4)])),
    totalKits: round(totalExpectedKits, 4),
    successProbability: round(root.successProbability, 8),
    probabilityGap: round(Math.max(0, root.maxSuccessProbability - root.successProbability), 8),
    pressure: round(pressure, 8),
    supplyCost: round(legacySupplyCost, 8),
    availabilityCost: round(availabilityCost, 8),
    legacySupplyCost: round(legacySupplyCost, 8),
    resourceCost: round(root.expectedCost, 8),
  };

  return {
    possible: true,
    terminal: false,
    input: normalizedInput,
    candidateCount: 1,
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
  assertRustMinEfInputSupported(normalizedInput);
  const solver = await getSolver(wasmUrl);
  solver.solveRoot(
    normalizedInput.start,
    normalizedInput.stock,
    HORIZON_FACTOR,
    NORM_POWER,
    TOLERANCE,
  );
  return simulate(normalizedInput, actionFactory(solver), runs, seed);
}
