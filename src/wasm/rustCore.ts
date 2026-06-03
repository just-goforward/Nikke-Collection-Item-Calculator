import { encodeState, type State, type Stock } from "./encode";

const KITS = ["blue", "purple", "yellow"] as const;
type Kit = (typeof KITS)[number];

export type RustCoreExports = {
  configureMemo?: (capLog2: number) => void;
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
};

export type RustMinEfRoot = {
  firstAction: Kit | null;
  successProbability: number;
  maxSuccessProbability: number;
  vector: Record<Kit, number>;
  expectedCost: number;
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

function actionFromIndex(index: number): Kit | null {
  return index < 0 ? null : KITS[index] || null;
}

export function createRustMinEfSolver(exports: RustCoreExports): RustMinEfSolver {
  exports.configureMemo?.(21);
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
      return actionFromIndex(
        exports.minEfActionAtOrSolve(
          stateId,
          stockUses.blue | 0,
          stockUses.purple | 0,
          stockUses.yellow | 0,
        ),
      );
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
