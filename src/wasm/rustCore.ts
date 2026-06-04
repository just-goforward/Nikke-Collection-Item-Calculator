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
  getMcEfCompletion?: () => number;
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
};

export type RustMonteCarloResult = {
  runs: number;
  completed: number;
  successProbability: number;
  vector: Record<Kit, number>;
};

export type RustMinEfSolver = {
  solveRoot: (
    start: State,
    stock: Stock,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustMinEfRoot;
  actionAt: (state: State, stockUses: Stock) => Kit | null;
};

export type RustPhase2Solver = {
  solveRoot: (
    start: State,
    stock: Stock,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustPhase2Root;
  actionAt: (
    state: State,
    stockUses: Stock,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => Kit | null;
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
  estimateExpectedCostAfterFirstActionFromCurrent: (
    start: State,
    stock: Stock,
    firstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor?: number,
    normPower?: number,
  ) => RustFirstActionEstimate;
  simulatePolicy: (start: State, stock: Stock, runs: number, seed: number) => RustMonteCarloResult;
  simulatePolicyAfterFirstAction: (
    start: State,
    stock: Stock,
    firstAction: Kit,
    runs: number,
    seed: number,
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
  return {
    runs,
    completed,
    successProbability: runs > 0 ? completed / runs : 0,
    vector: {
      blue: requireExport(exports, "getMcVecB")(),
      purple: requireExport(exports, "getMcVecP")(),
      yellow: requireExport(exports, "getMcVecY")(),
    },
  };
}

function rustStatusName(status: number) {
  if (status === RUST_STATUS_OK) return "ok";
  if (status === RUST_STATUS_BUDGET_EXCEEDED) return "budget_exceeded";
  if (status === RUST_STATUS_MEMO_FULL) return "memo_full";
  return `unknown_${status}`;
}

function assertRustStatusOk(exports: RustCoreExports, operation: string) {
  const status = exports.getSolveStatus?.() ?? RUST_STATUS_OK;
  if (status === RUST_STATUS_OK) return;
  throw new Error(`Rust solver ${operation} failed with status ${rustStatusName(status)}.`);
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
  const estimateExpectedCostAfterFirstActionFromCurrent = (
    start: State,
    stock: Stock,
    firstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor = 0.75,
    normPower = 3,
  ) => {
    const simulate = requireExport(exports, "simulateExpectedFAfterFirstActionFromPolicy");
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
      Math.max(0, Math.floor(runs) || 0),
      seed >>> 0,
      actionToIndex(firstAction),
    );
    assertRustStatusOk(exports, "phase2 first-action E[f] rollout");
    return {
      expectedCost: getMcEf(),
      completionRate: getMcEfCompletion(),
    };
  };
  const simulatePolicy = (start: State, stock: Stock, runs: number, seed: number) => {
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
  ) => {
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
    solvePhase2Slot(exports, start, stock, horizonFactor, normPower, tolerance);
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
    solveRoot(start, stock, horizonFactor = 0.75, normPower = 3, tolerance = 0) {
      const slot = solvePhase2Slot(exports, start, stock, horizonFactor, normPower, tolerance);
      return readPhase2Root(exports, slot);
    },
    actionAt(state, stockUses) {
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
    },
    rootCandidates,
    estimateExpectedCostAfterFirstAction,
    estimateExpectedCostAfterFirstActionFromCurrent,
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
      const slot = solvePhase2Slot(exports, start, stock, horizonFactor, normPower, tolerance);
      const baseline = readPhase2Root(exports, slot);
      const exactCandidates = readRootCandidates(exports, tolerance).filter(
        (candidate) => candidate.eligible,
      );
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
      return { baseline, selected, candidates };
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
