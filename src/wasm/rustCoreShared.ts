import { resolveRuntimeSupplyForecast } from "../lib/supplyForecastRuntime";
import { EXPECTED_28_DAY_GAIN } from "../solver/domain";
import type { Kit } from "../types";
import { assertRustStatusOk, RustSolveError } from "./rustStatus";
import type {
  RustCoreExports,
  RustMonteCarloResult,
  RustPhase2Candidate,
  RustPhase2Root,
  State,
  Stock,
  SupplyForecastContext,
} from "./rustTypes";

export const RUST_KITS: Kit[] = ["blue", "purple", "yellow"];

export function encodeState(grade: string, level: number, exp = 0): number {
  const gradeId = grade === "SR" ? 1 : 0;
  let normalizedLevel = Math.max(0, Math.floor(level));
  let normalizedExp = Math.max(0, Math.floor(exp));
  if (normalizedLevel >= 15) {
    normalizedLevel = 15;
    normalizedExp = 0;
  } else {
    normalizedLevel = Math.min(14, normalizedLevel);
  }
  return (gradeId * 16 + normalizedLevel) * 30 + Math.floor(normalizedExp / 100);
}

export type Phase2BuildContext = {
  forecastId: string;
  forecastProfileId: string;
  expectedGain: Stock;
  stateId: number;
  stock: Stock;
  horizonFactor: number;
  normPower: number;
  tolerance: number;
};

export function activeSupplyForecastContext(): SupplyForecastContext {
  const { forecastId, profile } = resolveRuntimeSupplyForecast();
  return {
    forecastId,
    forecastProfileId: profile.id,
    expectedGain: { ...profile.expectedGain },
  };
}

export function validateSupplyForecastContext(context: SupplyForecastContext) {
  for (const kit of RUST_KITS) {
    const gain = context.expectedGain[kit];
    if (!Number.isFinite(gain) || gain < 0) {
      throw new RangeError("Supply forecast gains must be non-negative finite numbers.");
    }
  }
  if (!context.forecastId || !context.forecastProfileId) {
    throw new RangeError("Supply forecast IDs must not be empty.");
  }
  return {
    forecastId: context.forecastId,
    forecastProfileId: context.forecastProfileId,
    expectedGain: { ...context.expectedGain },
  };
}

export function actionFromIndex(index: number): Kit | null {
  return index < 0 ? null : RUST_KITS[index] || null;
}

export function actionToIndex(action: Kit) {
  return RUST_KITS.indexOf(action);
}

export function stockToUses(stock: Stock): Stock {
  return {
    blue: Math.floor(stock.blue / 10),
    purple: Math.floor(stock.purple / 10),
    yellow: Math.floor(stock.yellow / 10),
  };
}

export function requireExport<T extends keyof RustCoreExports>(
  exports: RustCoreExports,
  name: T,
): NonNullable<RustCoreExports[T]> {
  const value = exports[name];
  if (typeof value !== "function") {
    throw new RustSolveError(String(name), null, "missing_export");
  }
  return value as NonNullable<RustCoreExports[T]>;
}

function rootCandidateFromExports({
  costAt,
  index,
  kit,
  maxSuccess,
  successAt,
  tolerance,
  validAt,
  vecB,
  vecP,
  vecY,
}: {
  costAt: (action: number) => number;
  index: number;
  kit: Kit;
  maxSuccess: number;
  successAt: (action: number) => number;
  tolerance: number;
  validAt: (action: number) => number;
  vecB: (action: number) => number;
  vecP: (action: number) => number;
  vecY: (action: number) => number;
}): RustPhase2Candidate | null {
  if (!validAt(index)) return null;
  const successProbability = successAt(index);
  const probabilityGap = Math.max(0, maxSuccess - successProbability);
  return {
    firstAction: kit,
    successProbability,
    maxSuccessProbability: maxSuccess,
    probabilityGap,
    vector: {
      blue: vecB(index),
      purple: vecP(index),
      yellow: vecY(index),
    },
    resourceCost: costAt(index),
    eligible: probabilityGap <= tolerance + 1e-12,
  };
}

export function readRootCandidates(exports: RustCoreExports, tolerance: number) {
  const validAt = requireExport(exports, "rootCandidateValid");
  const maxSuccess = requireExport(exports, "rootCandidateMaxSuccessProb")();
  const successAt = requireExport(exports, "rootCandidateSuccessProb");
  const vecB = requireExport(exports, "rootCandidateVecB");
  const vecP = requireExport(exports, "rootCandidateVecP");
  const vecY = requireExport(exports, "rootCandidateVecY");
  const costAt = requireExport(exports, "rootCandidateCost");

  return RUST_KITS.flatMap((kit, index) => {
    const candidate = rootCandidateFromExports({
      costAt,
      index,
      kit,
      maxSuccess,
      successAt,
      tolerance,
      validAt,
      vecB,
      vecP,
      vecY,
    });
    return candidate ? [candidate] : [];
  });
}

export function readMinEfRootCandidates(exports: RustCoreExports, tolerance: number) {
  const validAt = requireExport(exports, "minEfRootCandidateValid");
  const maxSuccess = requireExport(exports, "minEfRootCandidateMaxSuccessProb")();
  const successAt = requireExport(exports, "minEfRootCandidateSuccessProb");
  const vecB = requireExport(exports, "minEfRootCandidateVecB");
  const vecP = requireExport(exports, "minEfRootCandidateVecP");
  const vecY = requireExport(exports, "minEfRootCandidateVecY");
  const costAt = requireExport(exports, "minEfRootCandidateExpectedCost");

  return RUST_KITS.flatMap((kit, index) => {
    const candidate = rootCandidateFromExports({
      costAt,
      index,
      kit,
      maxSuccess,
      successAt,
      tolerance,
      validAt,
      vecB,
      vecP,
      vecY,
    });
    return candidate ? [candidate] : [];
  });
}

export function readPhase2Root(exports: RustCoreExports, slot: number): RustPhase2Root {
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

export function readMonteCarlo(exports: RustCoreExports): RustMonteCarloResult {
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
    ...readMonteCarloQuantiles(exports),
    ...(exports.getMcDepletion ? { depletion: exports.getMcDepletion() } : {}),
  };
}

function readMonteCarloQuantiles(exports: RustCoreExports) {
  if (!exports.getMcQuantileB || !exports.getMcQuantileP || !exports.getMcQuantileY) return {};
  return {
    quantiles: {
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
    },
  };
}

export function populationVariance(sumSq: number, mean: number, runs: number) {
  if (runs <= 0) return 0;
  return Math.max(0, sumSq / runs - mean * mean);
}

export function phase2BuildContext(
  start: State,
  stock: Stock,
  horizonFactor: number,
  normPower: number,
  tolerance: number,
  supplyForecast = activeSupplyForecastContext(),
): Phase2BuildContext {
  return {
    ...validateSupplyForecastContext(supplyForecast),
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

export function phase2ContextMatches(
  actual: Phase2BuildContext | null,
  expected: Phase2BuildContext,
  options: { compareTolerance?: boolean } = {},
) {
  if (!actual) return false;
  const compareTolerance = options.compareTolerance ?? true;
  return (
    actual.forecastId === expected.forecastId &&
    actual.forecastProfileId === expected.forecastProfileId &&
    nearlySame(actual.expectedGain.blue, expected.expectedGain.blue) &&
    nearlySame(actual.expectedGain.purple, expected.expectedGain.purple) &&
    nearlySame(actual.expectedGain.yellow, expected.expectedGain.yellow) &&
    actual.stateId === expected.stateId &&
    actual.stock.blue === expected.stock.blue &&
    actual.stock.purple === expected.stock.purple &&
    actual.stock.yellow === expected.stock.yellow &&
    nearlySame(actual.horizonFactor, expected.horizonFactor) &&
    nearlySame(actual.normPower, expected.normPower) &&
    (!compareTolerance || nearlySame(actual.tolerance, expected.tolerance))
  );
}

function nearlySame(a: number, b: number) {
  return Math.abs(a - b) <= 1e-12;
}

export function solvePhase2Slot(
  exports: RustCoreExports,
  state: State,
  stockPieces: Stock,
  horizonFactor: number,
  normPower: number,
  tolerance: number,
  supplyForecast = activeSupplyForecastContext(),
) {
  const solveCore = requireExport(exports, "solveCore");
  const stateId = encodeState(state.grade, state.level, state.exp ?? 0);
  // Raw pieces define availability-cost denominators.
  // WASM independently caps derived uses for memo keys.
  const slot = solveCore(
    stateId,
    stockPieces.blue | 0,
    stockPieces.purple | 0,
    stockPieces.yellow | 0,
    supplyForecast.expectedGain.blue,
    supplyForecast.expectedGain.purple,
    supplyForecast.expectedGain.yellow,
    horizonFactor,
    normPower,
    tolerance,
  );
  assertRustStatusOk(exports, "phase2 solve");
  return slot;
}

export function availabilityForKit(stock: Stock, kit: Kit, horizonFactor: number) {
  return stock[kit] + horizonFactor * EXPECTED_28_DAY_GAIN[kit];
}
