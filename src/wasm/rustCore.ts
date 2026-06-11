import { EXPECTED_28_DAY_GAIN } from "../solver";
import { encodeState, type State, type Stock } from "./encode";

const KITS = ["blue", "purple", "yellow"] as const;
type Kit = (typeof KITS)[number];
const RUST_STATUS_OK = 0;
const RUST_STATUS_BUDGET_EXCEEDED = 1;
const RUST_STATUS_MEMO_FULL = 2;
const RUST_MIN_EF_NODE_BUDGET = 2_000_000;

export type RustCoreExports = {
  configureMemo?: (capLog2: number) => void;
  configureNodeBudget?: (budget: number) => void;
  getSolveStatus?: () => number;
  solveCore?: (
    stateId: number,
    bluePieces: number,
    purplePieces: number,
    yellowPieces: number,
    horizonFactor: number,
    normPower: number,
    tolerance: number,
  ) => number;
  resAction?: (slot: number) => number;
  resSuccessProb?: (slot: number) => number;
  resMaxSuccessProb?: (slot: number) => number;
  resVecB?: (slot: number) => number;
  resVecP?: (slot: number) => number;
  resVecY?: (slot: number) => number;
  rootCandidateValid?: (action: number) => number;
  rootCandidateMaxSuccessProb?: () => number;
  rootCandidateSuccessProb?: (action: number) => number;
  rootCandidateVecB?: (action: number) => number;
  rootCandidateVecP?: (action: number) => number;
  rootCandidateVecY?: (action: number) => number;
  rootCandidateCost?: (action: number) => number;
  policyActionAt?: (
    stateId: number,
    blueUses: number,
    purpleUses: number,
    yellowUses: number,
  ) => number;
  simulateCore?: (
    stateId: number,
    bluePieces: number,
    purplePieces: number,
    yellowPieces: number,
    runs: number,
    seed: number,
  ) => void;
  simulateAfterFirstActionCore?: (
    stateId: number,
    bluePieces: number,
    purplePieces: number,
    yellowPieces: number,
    runs: number,
    seed: number,
    firstAction: number,
  ) => void;
  getMcCompleted?: () => number;
  getMcRuns?: () => number;
  getMcVecB?: () => number;
  getMcVecP?: () => number;
  getMcVecY?: () => number;
  getMcQuantileB?: (q: number) => number;
  getMcQuantileP?: (q: number) => number;
  getMcQuantileY?: (q: number) => number;
  getMcDepletion?: () => number;
  statesCount?: () => number;
  solveMinEf: (
    stateId: number,
    bluePieces: number,
    purplePieces: number,
    yellowPieces: number,
    horizonFactor: number,
    normPower: number,
    tolerance: number,
  ) => void;
  minEfAction: () => number;
  minEfSuccessProb: () => number;
  minEfMaxSuccessProb: () => number;
  minEfVecB: () => number;
  minEfVecP: () => number;
  minEfVecY: () => number;
  minEfExpectedCost: () => number;
  minEfRootCandidateValid?: (action: number) => number;
  minEfRootCandidateMaxSuccessProb?: () => number;
  minEfRootCandidateSuccessProb?: (action: number) => number;
  minEfRootCandidateVecB?: (action: number) => number;
  minEfRootCandidateVecP?: (action: number) => number;
  minEfRootCandidateVecY?: (action: number) => number;
  minEfRootCandidateExpectedCost?: (action: number) => number;
  minEfActionAtOrSolve: (
    stateId: number,
    blueUses: number,
    purpleUses: number,
    yellowUses: number,
  ) => number;
  simulateExpectedFAfterFirstAction?: (
    stateId: number,
    blueUses: number,
    purpleUses: number,
    yellowUses: number,
    initialBluePieces: number,
    initialPurplePieces: number,
    initialYellowPieces: number,
    horizonFactor: number,
    normPower: number,
    tolerance: number,
    runs: number,
    seed: number,
    firstAction: number,
  ) => void;
  simulateExpectedFAfterFirstActionFromPolicy?: (
    stateId: number,
    blueUses: number,
    purpleUses: number,
    yellowUses: number,
    initialBluePieces: number,
    initialPurplePieces: number,
    initialYellowPieces: number,
    horizonFactor: number,
    normPower: number,
    runs: number,
    seed: number,
    firstAction: number,
  ) => void;
  getMcEf?: () => number;
  getMcEfSumSq?: () => number;
  getMcEfRuns?: () => number;
  getMcEfCompletion?: () => number;
  simulateExpectedFPairFromPolicy?: (
    stateId: number,
    blueUses: number,
    purpleUses: number,
    yellowUses: number,
    initialBluePieces: number,
    initialPurplePieces: number,
    initialYellowPieces: number,
    horizonFactor: number,
    normPower: number,
    runs: number,
    seed: number,
    baselineFirstAction: number,
    selectedFirstAction: number,
  ) => void;
  getPairMeanBaseline?: () => number;
  getPairMeanSelected?: () => number;
  getPairMeanDelta?: () => number;
  getPairDeltaSumSq?: () => number;
  getPairRuns?: () => number;
  getPairCorrelation?: () => number;
  momentVectorAfterFirstActionFromPolicy?: (
    stateId: number,
    blueUses: number,
    purpleUses: number,
    yellowUses: number,
    firstAction: number,
  ) => void;
  momentMeanBUses?: () => number;
  momentMeanPUses?: () => number;
  momentMeanYUses?: () => number;
  momentSecondBBUses?: () => number;
  momentSecondPPUses?: () => number;
  momentSecondYYUses?: () => number;
  momentSecondBPUses?: () => number;
  momentSecondBYUses?: () => number;
  momentSecondPYUses?: () => number;
  momentVectorNodeCount?: () => number;
  cvarSetup?: (
    stateId: number,
    bluePieces: number,
    purplePieces: number,
    yellowPieces: number,
    horizonFactor: number,
    normPower: number,
    tolerance: number,
  ) => void;
  cvarFollowMeanAfterFirstAction?: (firstAction: number) => number;
  cvarNodeCount?: () => number;
};

export type RustMinEfRoot = {
  firstAction: Kit | null;
  successProbability: number;
  maxSuccessProbability: number;
  vector: Record<Kit, number>;
  expectedCost: number;
  states?: number;
};

export type RustPhase2Root = {
  firstAction: Kit | null;
  successProbability: number;
  maxSuccessProbability: number;
  vector: Record<Kit, number>;
  states: number;
};

export type RustFirstActionEstimate = {
  expectedCost: number;
  completionRate: number;
};

export type RustFirstActionMomentEstimate = RustFirstActionEstimate & {
  runs: number;
  sumSq: number;
  variance: number;
  standardError: number;
};

export type RustPairedExpectedCostEstimate = {
  runs: number;
  meanBaseline: number;
  meanSelected: number;
  meanDelta: number;
  deltaSumSq: number;
  deltaVariance: number;
  standardError: number;
  upper95: number;
  correlation: number;
};

export type RustA2MomentEstimate = {
  mean: Record<Kit, number>;
  covariance: {
    blueBlue: number;
    purplePurple: number;
    yellowYellow: number;
    bluePurple: number;
    blueYellow: number;
    purpleYellow: number;
  };
  baseCost: number;
  secondOrderCorrection: number;
  surrogateCost: number;
  nodeCount: number;
};

export type RustExactExpectedCostEstimate = {
  expectedCost: number;
  nodeCount: number;
};

export type RustPhase2Candidate = {
  firstAction: Kit;
  successProbability: number;
  maxSuccessProbability: number;
  probabilityGap: number;
  vector: Record<Kit, number>;
  resourceCost: number;
  eligible: boolean;
};

export type RustRerankedCandidate = RustPhase2Candidate & RustFirstActionEstimate;

export type RustRerankResult = {
  baseline: RustPhase2Root;
  selected: RustRerankedCandidate;
  candidates: RustRerankedCandidate[];
  policy: RustPhase2Policy;
};

export type RustMonteCarloResult = {
  runs: number;
  completed: number;
  successProbability: number;
  vector: Record<Kit, number>;
  quantiles?: Record<Kit, { p50: number; p90: number; p95: number }>;
  depletion?: number;
};

export type RustMinEfSolver = {
  solveRoot: (
    start: State,
    stock: Stock,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustMinEfRoot;
  rootCandidates: (
    start: State,
    stock: Stock,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustPhase2Candidate[];
  actionAt: (state: State, stockUses: Stock) => Kit | null;
};

export type RustPhase2Policy = {
  root: RustPhase2Root;
  candidates: RustPhase2Candidate[];
  actionAt: (state: State, stockUses: Stock) => Kit | null;
};

export type RustPhase2Solver = {
  buildPolicy: (
    start: State,
    stock: Stock,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustPhase2Policy;
  solveRoot: (
    start: State,
    stock: Stock,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustPhase2Root;
  rootCandidates: (
    start: State,
    stock: Stock,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustPhase2Candidate[];
  estimateExpectedCostAfterFirstAction: (
    start: State,
    stock: Stock,
    firstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustFirstActionEstimate;
  // Follows the currently built phase2 policy. The current build's tolerance is intentionally
  // inherited because this rollout does not rebuild or reselect the policy.
  estimateExpectedCostAfterFirstActionFromCurrent: (
    start: State,
    stock: Stock,
    firstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor?: number,
    normPower?: number,
  ) => RustFirstActionEstimate;
  estimateExpectedCostAfterFirstActionFromCurrentWithMoments: (
    start: State,
    stock: Stock,
    firstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor?: number,
    normPower?: number,
  ) => RustFirstActionMomentEstimate;
  estimateExpectedCostPairFromCurrent: (
    start: State,
    stock: Stock,
    baselineFirstAction: Kit,
    selectedFirstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor?: number,
    normPower?: number,
  ) => RustPairedExpectedCostEstimate;
  estimateA2SurrogateAfterFirstActionFromCurrent: (
    start: State,
    stock: Stock,
    firstAction: Kit,
    horizonFactor?: number,
    normPower?: number,
  ) => RustA2MomentEstimate;
  estimateExactExpectedCostAfterFirstActionFromCurrent: (
    start: State,
    stock: Stock,
    firstAction: Kit,
    horizonFactor?: number,
    normPower?: number,
  ) => RustExactExpectedCostEstimate;
  simulatePolicy: (
    start: State,
    stock: Stock,
    runs: number,
    seed: number,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustMonteCarloResult;
  simulatePolicyAfterFirstAction: (
    start: State,
    stock: Stock,
    firstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustMonteCarloResult;
  selectFirstActionByExpectedCost: (
    start: State,
    stock: Stock,
    runs: number,
    seed: number,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustRerankResult | null;
};

function actionFromIndex(index: number): Kit | null {
  return index < 0 ? null : KITS[index] || null;
}

function actionToIndex(action: Kit) {
  return KITS.indexOf(action);
}

function stockToUses(stock: Stock): Stock {
  return {
    blue: Math.floor(stock.blue / 10),
    purple: Math.floor(stock.purple / 10),
    yellow: Math.floor(stock.yellow / 10),
  };
}

function readRootCandidates(exports: RustCoreExports, tolerance: number): RustPhase2Candidate[] {
  const valid = requireExport(exports, "rootCandidateValid");
  const maxSuccess = requireExport(exports, "rootCandidateMaxSuccessProb")();
  const success = requireExport(exports, "rootCandidateSuccessProb");
  const vecB = requireExport(exports, "rootCandidateVecB");
  const vecP = requireExport(exports, "rootCandidateVecP");
  const vecY = requireExport(exports, "rootCandidateVecY");
  const cost = requireExport(exports, "rootCandidateCost");

  return KITS.flatMap((kit, index) => {
    if (!valid(index)) return [];
    const successProbability = success(index);
    const probabilityGap = Math.max(0, maxSuccess - successProbability);
    return [
      {
        firstAction: kit,
        successProbability,
        maxSuccessProbability: maxSuccess,
        probabilityGap,
        vector: {
          blue: vecB(index),
          purple: vecP(index),
          yellow: vecY(index),
        },
        resourceCost: cost(index),
        eligible: probabilityGap <= tolerance + 1e-12,
      },
    ];
  });
}

function readMinEfRootCandidates(
  exports: RustCoreExports,
  tolerance: number,
): RustPhase2Candidate[] {
  const valid = requireExport(exports, "minEfRootCandidateValid");
  const maxSuccess = requireExport(exports, "minEfRootCandidateMaxSuccessProb")();
  const success = requireExport(exports, "minEfRootCandidateSuccessProb");
  const vecB = requireExport(exports, "minEfRootCandidateVecB");
  const vecP = requireExport(exports, "minEfRootCandidateVecP");
  const vecY = requireExport(exports, "minEfRootCandidateVecY");
  const expectedCost = requireExport(exports, "minEfRootCandidateExpectedCost");

  return KITS.flatMap((kit, index) => {
    if (!valid(index)) return [];
    const successProbability = success(index);
    const probabilityGap = Math.max(0, maxSuccess - successProbability);
    return [
      {
        firstAction: kit,
        successProbability,
        maxSuccessProbability: maxSuccess,
        probabilityGap,
        vector: {
          blue: vecB(index),
          purple: vecP(index),
          yellow: vecY(index),
        },
        resourceCost: expectedCost(index),
        eligible: probabilityGap <= tolerance + 1e-12,
      },
    ];
  });
}

function readPhase2Root(exports: RustCoreExports, slot: number): RustPhase2Root {
  const resAction = requireExport(exports, "resAction");
  const resSuccessProb = requireExport(exports, "resSuccessProb");
  const resMaxSuccessProb = requireExport(exports, "resMaxSuccessProb");
  const resVecB = requireExport(exports, "resVecB");
  const resVecP = requireExport(exports, "resVecP");
  const resVecY = requireExport(exports, "resVecY");
  return {
    firstAction: actionFromIndex(resAction(slot)),
    successProbability: resSuccessProb(slot),
    maxSuccessProbability: resMaxSuccessProb(slot),
    vector: {
      blue: resVecB(slot),
      purple: resVecP(slot),
      yellow: resVecY(slot),
    },
    states: exports.statesCount?.() ?? 0,
  };
}

function readMonteCarlo(exports: RustCoreExports): RustMonteCarloResult {
  const runs = requireExport(exports, "getMcRuns")();
  const completed = requireExport(exports, "getMcCompleted")();
  const quantiles =
    exports.getMcQuantileB && exports.getMcQuantileP && exports.getMcQuantileY
      ? {
          blue: {
            p50: exports.getMcQuantileB(0.5) * 10,
            p90: exports.getMcQuantileB(0.9) * 10,
            p95: exports.getMcQuantileB(0.95) * 10,
          },
          purple: {
            p50: exports.getMcQuantileP(0.5) * 10,
            p90: exports.getMcQuantileP(0.9) * 10,
            p95: exports.getMcQuantileP(0.95) * 10,
          },
          yellow: {
            p50: exports.getMcQuantileY(0.5) * 10,
            p90: exports.getMcQuantileY(0.9) * 10,
            p95: exports.getMcQuantileY(0.95) * 10,
          },
        }
      : undefined;
  return {
    runs,
    completed,
    successProbability: runs > 0 ? completed / runs : 0,
    vector: {
      blue: requireExport(exports, "getMcVecB")(),
      purple: requireExport(exports, "getMcVecP")(),
      yellow: requireExport(exports, "getMcVecY")(),
    },
    ...(quantiles ? { quantiles } : {}),
    ...(exports.getMcDepletion ? { depletion: exports.getMcDepletion() } : {}),
  };
}

function rustStatusName(status: number) {
  if (status === RUST_STATUS_OK) return "ok";
  if (status === RUST_STATUS_BUDGET_EXCEEDED) return "budget_exceeded";
  if (status === RUST_STATUS_MEMO_FULL) return "memo_full";
  return `unknown_${status}`;
}

export class RustSolveError extends Error {
  constructor(
    operation: string,
    readonly status: number,
  ) {
    super(`Rust solver ${operation} failed with status ${rustStatusName(status)}.`);
    this.name = "RustSolveError";
  }
}

export function isMemoFull(error: unknown): boolean {
  return error instanceof RustSolveError && error.status === RUST_STATUS_MEMO_FULL;
}

function populationVariance(sumSq: number, mean: number, runs: number) {
  if (runs <= 0) return 0;
  return Math.max(0, sumSq / runs - mean * mean);
}

function availabilityForKit(stock: Stock, kit: Kit, horizonFactor: number) {
  return stock[kit] + horizonFactor * EXPECTED_28_DAY_GAIN[kit];
}

function availabilityCost(
  vector: Record<Kit, number>,
  stock: Stock,
  horizonFactor: number,
  p: number,
) {
  const ratios = KITS.map((kit) => {
    const availability = availabilityForKit(stock, kit, horizonFactor);
    if (availability > 0) return vector[kit] / availability;
    return vector[kit] > 1e-12 ? Number.POSITIVE_INFINITY : 0;
  });
  if (!Number.isFinite(p)) return Math.max(...ratios);
  return ratios.reduce((sum, ratio) => sum + ratio ** p, 0) ** (1 / p);
}

function availabilityHessian(
  mean: Record<Kit, number>,
  stock: Stock,
  horizonFactor: number,
  p: number,
) {
  if (!Number.isFinite(p) || p <= 1) return [0, 0, 0, 0, 0, 0] as const;
  const availability = KITS.map((kit) => availabilityForKit(stock, kit, horizonFactor));
  if (availability.some((value) => value <= 0)) return [0, 0, 0, 0, 0, 0] as const;
  const c = KITS.map((kit) => Math.max(0, mean[kit]));
  const w = availability.map((value) => value ** -p);
  const s = c.reduce((total, value, index) => total + w[index] * value ** p, 0);
  if (s <= 0) return [0, 0, 0, 0, 0, 0] as const;
  const crossFactor = (1 - p) * s ** (1 / p - 2);
  const diagFactor = (p - 1) * s ** (1 / p - 1);
  const off = (i: number, j: number) =>
    crossFactor * w[i] * w[j] * c[i] ** (p - 1) * c[j] ** (p - 1);
  const diag = (i: number) =>
    crossFactor * w[i] * w[i] * c[i] ** (2 * p - 2) +
    diagFactor * w[i] * c[i] ** Math.max(0, p - 2);
  return [diag(0), diag(1), diag(2), off(0, 1), off(0, 2), off(1, 2)] as const;
}

function assertRustStatusOk(exports: RustCoreExports, operation: string) {
  const status = exports.getSolveStatus?.() ?? RUST_STATUS_OK;
  if (status === RUST_STATUS_OK) return;
  throw new RustSolveError(operation, status);
}

function requireExport<T extends keyof RustCoreExports>(
  exports: RustCoreExports,
  name: T,
): NonNullable<RustCoreExports[T]> {
  const value = exports[name];
  if (typeof value !== "function")
    throw new Error(`Rust solver export ${String(name)} is missing.`);
  return value as NonNullable<RustCoreExports[T]>;
}

function solvePhase2Slot(
  exports: RustCoreExports,
  state: State,
  stockPieces: Stock,
  horizonFactor: number,
  normPower: number,
  tolerance: number,
) {
  const solveCore = requireExport(exports, "solveCore");
  const stateId = encodeState(state.grade, state.level, state.exp ?? 0);
  const slot = solveCore(
    stateId,
    stockPieces.blue | 0,
    stockPieces.purple | 0,
    stockPieces.yellow | 0,
    horizonFactor,
    normPower,
    tolerance,
  );
  assertRustStatusOk(exports, "phase2 solve");
  return slot;
}

type Phase2BuildContext = {
  stateId: number;
  stock: Stock;
  horizonFactor: number;
  normPower: number;
  tolerance: number;
};

function phase2BuildContext(
  start: State,
  stock: Stock,
  horizonFactor: number,
  normPower: number,
  tolerance: number,
): Phase2BuildContext {
  return {
    stateId: encodeState(start.grade, start.level, start.exp ?? 0),
    stock: {
      blue: stock.blue | 0,
      purple: stock.purple | 0,
      yellow: stock.yellow | 0,
    },
    horizonFactor,
    normPower,
    tolerance,
  };
}

function nearlySame(a: number, b: number) {
  return Math.abs(a - b) <= 1e-12;
}

function phase2ContextMatches(
  actual: Phase2BuildContext | null,
  expected: Phase2BuildContext,
  options: { compareTolerance?: boolean } = {},
) {
  if (!actual) return false;
  const compareTolerance = options.compareTolerance ?? true;
  return (
    actual.stateId === expected.stateId &&
    actual.stock.blue === expected.stock.blue &&
    actual.stock.purple === expected.stock.purple &&
    actual.stock.yellow === expected.stock.yellow &&
    nearlySame(actual.horizonFactor, expected.horizonFactor) &&
    nearlySame(actual.normPower, expected.normPower) &&
    (!compareTolerance || nearlySame(actual.tolerance, expected.tolerance))
  );
}

export function createRustMinEfSolver(exports: RustCoreExports): RustMinEfSolver {
  exports.configureMemo?.(21);
  exports.configureNodeBudget?.(RUST_MIN_EF_NODE_BUDGET);
  return {
    solveRoot(start, stock, horizonFactor = 0.75, normPower = 3, tolerance = 0) {
      const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
      exports.solveMinEf(
        stateId,
        stock.blue | 0,
        stock.purple | 0,
        stock.yellow | 0,
        horizonFactor,
        normPower,
        tolerance,
      );
      assertRustStatusOk(exports, "root solve");
      return {
        firstAction: actionFromIndex(exports.minEfAction()),
        successProbability: exports.minEfSuccessProb(),
        maxSuccessProbability: exports.minEfMaxSuccessProb(),
        vector: {
          blue: exports.minEfVecB(),
          purple: exports.minEfVecP(),
          yellow: exports.minEfVecY(),
        },
        expectedCost: exports.minEfExpectedCost(),
      };
    },
    rootCandidates(start, stock, horizonFactor = 0.75, normPower = 3, tolerance = 0) {
      const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
      exports.solveMinEf(
        stateId,
        stock.blue | 0,
        stock.purple | 0,
        stock.yellow | 0,
        horizonFactor,
        normPower,
        tolerance,
      );
      assertRustStatusOk(exports, "min-ef root candidates");
      return readMinEfRootCandidates(exports, tolerance);
    },
    actionAt(state, stockUses) {
      const stateId = encodeState(state.grade, state.level, state.exp ?? 0);
      const action = exports.minEfActionAtOrSolve(
        stateId,
        stockUses.blue | 0,
        stockUses.purple | 0,
        stockUses.yellow | 0,
      );
      assertRustStatusOk(exports, "action lookup");
      return actionFromIndex(action);
    },
  };
}

export function createRustPhase2Solver(exports: RustCoreExports): RustPhase2Solver {
  exports.configureMemo?.(21);
  exports.configureNodeBudget?.(0);
  let currentBuild: Phase2BuildContext | null = null;
  let buildGeneration = 0;

  const recordBuild = (context: Phase2BuildContext) => {
    currentBuild = context;
    buildGeneration += 1;
    return buildGeneration;
  };

  const assertCurrentBuild = (
    expected: Phase2BuildContext,
    operation: string,
    options: { compareTolerance?: boolean } = {},
  ) => {
    if (phase2ContextMatches(currentBuild, expected, options)) return;
    throw new Error(`Rust phase2 ${operation} does not match the current policy build.`);
  };

  const assertPolicyGeneration = (generation: number) => {
    if (generation === buildGeneration) return;
    throw new Error("Rust phase2 policy handle is stale because a newer policy was built.");
  };

  const actionAtForGeneration = (generation: number, state: State, stockUses: Stock) => {
    assertPolicyGeneration(generation);
    const policyActionAt = requireExport(exports, "policyActionAt");
    const stateId = encodeState(state.grade, state.level, state.exp ?? 0);
    const action = policyActionAt(
      stateId,
      stockUses.blue | 0,
      stockUses.purple | 0,
      stockUses.yellow | 0,
    );
    assertRustStatusOk(exports, "phase2 action lookup");
    return actionFromIndex(action);
  };

  const buildPolicy = (
    start: State,
    stock: Stock,
    horizonFactor = 0.75,
    normPower = 3,
    tolerance = 0,
  ): RustPhase2Policy => {
    const context = phase2BuildContext(start, stock, horizonFactor, normPower, tolerance);
    const slot = solvePhase2Slot(exports, start, stock, horizonFactor, normPower, tolerance);
    const generation = recordBuild(context);
    return {
      root: readPhase2Root(exports, slot),
      candidates: readRootCandidates(exports, tolerance),
      actionAt(state, stockUses) {
        return actionAtForGeneration(generation, state, stockUses);
      },
    };
  };

  const estimateExpectedCostAfterFirstActionFromCurrentWithMoments = (
    start: State,
    stock: Stock,
    firstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor = 0.75,
    normPower = 3,
  ) => {
    assertCurrentBuild(
      phase2BuildContext(start, stock, horizonFactor, normPower, 0),
      "current-policy first-action E[f] rollout",
      { compareTolerance: false },
    );
    const simulate = requireExport(exports, "simulateExpectedFAfterFirstActionFromPolicy");
    const getMcEf = requireExport(exports, "getMcEf");
    const getMcEfSumSq = requireExport(exports, "getMcEfSumSq");
    const getMcEfRuns = requireExport(exports, "getMcEfRuns");
    const getMcEfCompletion = requireExport(exports, "getMcEfCompletion");
    const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
    const stockUses = stockToUses(stock);
    simulate(
      stateId,
      stockUses.blue | 0,
      stockUses.purple | 0,
      stockUses.yellow | 0,
      stock.blue | 0,
      stock.purple | 0,
      stock.yellow | 0,
      horizonFactor,
      normPower,
      Math.max(0, Math.floor(runs) || 0),
      seed >>> 0,
      actionToIndex(firstAction),
    );
    assertRustStatusOk(exports, "phase2 first-action E[f] rollout");
    const expectedCost = getMcEf();
    const actualRuns = getMcEfRuns();
    const sumSq = getMcEfSumSq();
    const variance = populationVariance(sumSq, expectedCost, actualRuns);
    return {
      expectedCost,
      completionRate: getMcEfCompletion(),
      runs: actualRuns,
      sumSq,
      variance,
      standardError: actualRuns > 0 ? Math.sqrt(variance / actualRuns) : 0,
    };
  };
  const estimateExpectedCostAfterFirstActionFromCurrent = (
    start: State,
    stock: Stock,
    firstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor = 0.75,
    normPower = 3,
  ) => {
    const estimate = estimateExpectedCostAfterFirstActionFromCurrentWithMoments(
      start,
      stock,
      firstAction,
      runs,
      seed,
      horizonFactor,
      normPower,
    );
    return {
      expectedCost: estimate.expectedCost,
      completionRate: estimate.completionRate,
    };
  };
  const estimateExpectedCostPairFromCurrent = (
    start: State,
    stock: Stock,
    baselineFirstAction: Kit,
    selectedFirstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor = 0.75,
    normPower = 3,
  ) => {
    assertCurrentBuild(
      phase2BuildContext(start, stock, horizonFactor, normPower, 0),
      "current-policy paired E[f] rollout",
      { compareTolerance: false },
    );
    const simulate = requireExport(exports, "simulateExpectedFPairFromPolicy");
    const getPairRuns = requireExport(exports, "getPairRuns");
    const getPairMeanBaseline = requireExport(exports, "getPairMeanBaseline");
    const getPairMeanSelected = requireExport(exports, "getPairMeanSelected");
    const getPairMeanDelta = requireExport(exports, "getPairMeanDelta");
    const getPairDeltaSumSq = requireExport(exports, "getPairDeltaSumSq");
    const getPairCorrelation = requireExport(exports, "getPairCorrelation");
    const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
    const stockUses = stockToUses(stock);
    simulate(
      stateId,
      stockUses.blue | 0,
      stockUses.purple | 0,
      stockUses.yellow | 0,
      stock.blue | 0,
      stock.purple | 0,
      stock.yellow | 0,
      horizonFactor,
      normPower,
      Math.max(0, Math.floor(runs) || 0),
      seed >>> 0,
      actionToIndex(baselineFirstAction),
      actionToIndex(selectedFirstAction),
    );
    assertRustStatusOk(exports, "phase2 paired E[f] rollout");
    const actualRuns = getPairRuns();
    const meanDelta = getPairMeanDelta();
    const deltaSumSq = getPairDeltaSumSq();
    const deltaVariance = populationVariance(deltaSumSq, meanDelta, actualRuns);
    const standardError = actualRuns > 0 ? Math.sqrt(deltaVariance / actualRuns) : 0;
    return {
      runs: actualRuns,
      meanBaseline: getPairMeanBaseline(),
      meanSelected: getPairMeanSelected(),
      meanDelta,
      deltaSumSq,
      deltaVariance,
      standardError,
      upper95: meanDelta + 1.96 * standardError,
      correlation: getPairCorrelation(),
    };
  };
  const estimateA2SurrogateAfterFirstActionFromCurrent = (
    start: State,
    stock: Stock,
    firstAction: Kit,
    horizonFactor = 0.75,
    normPower = 3,
  ) => {
    assertCurrentBuild(
      phase2BuildContext(start, stock, horizonFactor, normPower, 0),
      "current-policy A2 moment rollout",
      { compareTolerance: false },
    );
    const moment = requireExport(exports, "momentVectorAfterFirstActionFromPolicy");
    const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
    const stockUses = stockToUses(stock);
    moment(
      stateId,
      stockUses.blue | 0,
      stockUses.purple | 0,
      stockUses.yellow | 0,
      actionToIndex(firstAction),
    );
    assertRustStatusOk(exports, "phase2 A2 moment rollout");

    const mean = {
      blue: requireExport(exports, "momentMeanBUses")() * 10,
      purple: requireExport(exports, "momentMeanPUses")() * 10,
      yellow: requireExport(exports, "momentMeanYUses")() * 10,
    };
    const second = {
      blueBlue: requireExport(exports, "momentSecondBBUses")() * 100,
      purplePurple: requireExport(exports, "momentSecondPPUses")() * 100,
      yellowYellow: requireExport(exports, "momentSecondYYUses")() * 100,
      bluePurple: requireExport(exports, "momentSecondBPUses")() * 100,
      blueYellow: requireExport(exports, "momentSecondBYUses")() * 100,
      purpleYellow: requireExport(exports, "momentSecondPYUses")() * 100,
    };
    const covariance = {
      blueBlue: Math.max(0, second.blueBlue - mean.blue * mean.blue),
      purplePurple: Math.max(0, second.purplePurple - mean.purple * mean.purple),
      yellowYellow: Math.max(0, second.yellowYellow - mean.yellow * mean.yellow),
      bluePurple: second.bluePurple - mean.blue * mean.purple,
      blueYellow: second.blueYellow - mean.blue * mean.yellow,
      purpleYellow: second.purpleYellow - mean.purple * mean.yellow,
    };
    const baseCost = availabilityCost(mean, stock, horizonFactor, normPower);
    const [hBB, hPP, hYY, hBP, hBY, hPY] = availabilityHessian(
      mean,
      stock,
      horizonFactor,
      normPower,
    );
    const secondOrderCorrection =
      0.5 *
      (hBB * covariance.blueBlue +
        hPP * covariance.purplePurple +
        hYY * covariance.yellowYellow +
        2 * hBP * covariance.bluePurple +
        2 * hBY * covariance.blueYellow +
        2 * hPY * covariance.purpleYellow);
    return {
      mean,
      covariance,
      baseCost,
      secondOrderCorrection,
      surrogateCost: Math.max(0, baseCost + secondOrderCorrection),
      nodeCount: requireExport(exports, "momentVectorNodeCount")(),
    };
  };
  const estimateExactExpectedCostAfterFirstActionFromCurrent = (
    start: State,
    stock: Stock,
    firstAction: Kit,
    horizonFactor = 0.75,
    normPower = 3,
  ) => {
    assertCurrentBuild(
      phase2BuildContext(start, stock, horizonFactor, normPower, 0),
      "current-policy exact E[f] rollout",
      { compareTolerance: false },
    );
    const setup = requireExport(exports, "cvarSetup");
    const follow = requireExport(exports, "cvarFollowMeanAfterFirstAction");
    const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
    const tolerance = currentBuild?.tolerance ?? 0;
    setup(
      stateId,
      stock.blue | 0,
      stock.purple | 0,
      stock.yellow | 0,
      horizonFactor,
      normPower,
      tolerance,
    );
    assertRustStatusOk(exports, "phase2 exact E[f] setup");
    const expectedCost = follow(actionToIndex(firstAction));
    assertRustStatusOk(exports, "phase2 exact E[f] rollout");
    return {
      expectedCost,
      nodeCount: requireExport(exports, "cvarNodeCount")(),
    };
  };
  const simulatePolicy = (
    start: State,
    stock: Stock,
    runs: number,
    seed: number,
    horizonFactor = 0.75,
    normPower = 3,
    tolerance = 0,
  ) => {
    assertCurrentBuild(
      phase2BuildContext(start, stock, horizonFactor, normPower, tolerance),
      "Monte Carlo validation",
    );
    const simulate = requireExport(exports, "simulateCore");
    const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
    simulate(
      stateId,
      stock.blue | 0,
      stock.purple | 0,
      stock.yellow | 0,
      Math.max(0, Math.floor(runs) || 0),
      seed >>> 0,
    );
    assertRustStatusOk(exports, "phase2 Monte Carlo validation");
    return readMonteCarlo(exports);
  };
  const simulatePolicyAfterFirstAction = (
    start: State,
    stock: Stock,
    firstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor = 0.75,
    normPower = 3,
    tolerance = 0,
  ) => {
    assertCurrentBuild(
      phase2BuildContext(start, stock, horizonFactor, normPower, tolerance),
      "first-action Monte Carlo validation",
    );
    const simulate = requireExport(exports, "simulateAfterFirstActionCore");
    const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
    simulate(
      stateId,
      stock.blue | 0,
      stock.purple | 0,
      stock.yellow | 0,
      Math.max(0, Math.floor(runs) || 0),
      seed >>> 0,
      actionToIndex(firstAction),
    );
    assertRustStatusOk(exports, "phase2 first-action Monte Carlo validation");
    return readMonteCarlo(exports);
  };
  const rootCandidates = (
    start: State,
    stock: Stock,
    horizonFactor = 0.75,
    normPower = 3,
    tolerance = 0,
  ) => {
    const context = phase2BuildContext(start, stock, horizonFactor, normPower, tolerance);
    solvePhase2Slot(exports, start, stock, horizonFactor, normPower, tolerance);
    recordBuild(context);
    return readRootCandidates(exports, tolerance);
  };
  const estimateExpectedCostAfterFirstAction = (
    start: State,
    stock: Stock,
    firstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor = 0.75,
    normPower = 3,
    tolerance = 0,
  ) => {
    const simulate = requireExport(exports, "simulateExpectedFAfterFirstAction");
    const getMcEf = requireExport(exports, "getMcEf");
    const getMcEfCompletion = requireExport(exports, "getMcEfCompletion");
    const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
    const stockUses = stockToUses(stock);
    simulate(
      stateId,
      stockUses.blue | 0,
      stockUses.purple | 0,
      stockUses.yellow | 0,
      stock.blue | 0,
      stock.purple | 0,
      stock.yellow | 0,
      horizonFactor,
      normPower,
      tolerance,
      Math.max(0, Math.floor(runs) || 0),
      seed >>> 0,
      actionToIndex(firstAction),
    );
    assertRustStatusOk(exports, "phase2 first-action E[f] simulation");
    return {
      expectedCost: getMcEf(),
      completionRate: getMcEfCompletion(),
    };
  };
  return {
    buildPolicy,
    solveRoot(start, stock, horizonFactor = 0.75, normPower = 3, tolerance = 0) {
      return buildPolicy(start, stock, horizonFactor, normPower, tolerance).root;
    },
    rootCandidates,
    estimateExpectedCostAfterFirstAction,
    estimateExpectedCostAfterFirstActionFromCurrent,
    estimateExpectedCostAfterFirstActionFromCurrentWithMoments,
    estimateExpectedCostPairFromCurrent,
    estimateA2SurrogateAfterFirstActionFromCurrent,
    estimateExactExpectedCostAfterFirstActionFromCurrent,
    simulatePolicy,
    simulatePolicyAfterFirstAction,
    selectFirstActionByExpectedCost(
      start,
      stock,
      runs,
      seed,
      horizonFactor = 0.75,
      normPower = 3,
      tolerance = 0,
    ) {
      const policy = buildPolicy(start, stock, horizonFactor, normPower, tolerance);
      const baseline = policy.root;
      const exactCandidates = policy.candidates.filter((candidate) => candidate.eligible);
      if (exactCandidates.length === 0) return null;

      const candidates = exactCandidates.map((candidate) => ({
        ...candidate,
        ...estimateExpectedCostAfterFirstActionFromCurrent(
          start,
          stock,
          candidate.firstAction,
          runs,
          seed,
          horizonFactor,
          normPower,
        ),
      }));
      const selected = candidates.reduce((best, candidate) => {
        const dc = candidate.expectedCost - best.expectedCost;
        if (Math.abs(dc) > 1e-12) return dc < 0 ? candidate : best;
        const rc = candidate.resourceCost - best.resourceCost;
        if (Math.abs(rc) > 1e-12) return rc < 0 ? candidate : best;
        return candidate.successProbability > best.successProbability ? candidate : best;
      });
      return { baseline, selected, candidates, policy };
    },
  };
}

export async function loadRustMinEfSolver(url: string): Promise<RustMinEfSolver> {
  let instance: WebAssembly.Instance;
  try {
    ({ instance } = await WebAssembly.instantiateStreaming(fetch(url)));
  } catch {
    const bytes = await (await fetch(url)).arrayBuffer();
    ({ instance } = await WebAssembly.instantiate(bytes));
  }
  return createRustMinEfSolver(instance.exports as unknown as RustCoreExports);
}

export async function loadRustPhase2Solver(url: string): Promise<RustPhase2Solver> {
  let instance: WebAssembly.Instance;
  try {
    ({ instance } = await WebAssembly.instantiateStreaming(fetch(url)));
  } catch {
    const bytes = await (await fetch(url)).arrayBuffer();
    ({ instance } = await WebAssembly.instantiate(bytes));
  }
  return createRustPhase2Solver(instance.exports as unknown as RustCoreExports);
}
