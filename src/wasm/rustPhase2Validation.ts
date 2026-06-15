import type { Kit } from "../types";
import {
  actionToIndex,
  encodeState,
  phase2BuildContext,
  readMonteCarlo,
  requireExport,
} from "./rustCoreShared";
import { assertCurrentPhase2Build, type Phase2FactoryState } from "./rustPhase2PolicyState";
import { assertRustStatusOk } from "./rustStatus";
import type { RustMonteCarloResult, State, Stock } from "./rustTypes";

export function simulatePolicy(
  state: Phase2FactoryState,
  start: State,
  stock: Stock,
  runs: number,
  seed: number,
  horizonFactor = 0.75,
  normPower = 3,
  tolerance = 0,
): RustMonteCarloResult {
  assertCurrentPhase2Build(
    state,
    phase2BuildContext(start, stock, horizonFactor, normPower, tolerance),
    "Monte Carlo validation",
  );
  requireExport(state.exports, "simulateCore")(
    encodeState(start.grade, start.level, start.exp ?? 0),
    stock.blue | 0,
    stock.purple | 0,
    stock.yellow | 0,
    Math.max(0, Math.floor(runs) || 0),
    seed >>> 0,
  );
  assertRustStatusOk(state.exports, "phase2 Monte Carlo validation");
  return readMonteCarlo(state.exports);
}

export function simulatePolicyAfterFirstAction(
  state: Phase2FactoryState,
  start: State,
  stock: Stock,
  firstAction: Kit,
  runs: number,
  seed: number,
  horizonFactor = 0.75,
  normPower = 3,
  tolerance = 0,
): RustMonteCarloResult {
  assertCurrentPhase2Build(
    state,
    phase2BuildContext(start, stock, horizonFactor, normPower, tolerance),
    "first-action Monte Carlo validation",
  );
  requireExport(state.exports, "simulateAfterFirstActionCore")(
    encodeState(start.grade, start.level, start.exp ?? 0),
    stock.blue | 0,
    stock.purple | 0,
    stock.yellow | 0,
    Math.max(0, Math.floor(runs) || 0),
    seed >>> 0,
    actionToIndex(firstAction),
  );
  assertRustStatusOk(state.exports, "phase2 first-action Monte Carlo validation");
  return readMonteCarlo(state.exports);
}
