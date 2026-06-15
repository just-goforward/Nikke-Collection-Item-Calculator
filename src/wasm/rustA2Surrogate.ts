import type { Kit } from "../types";
import {
  availabilityCost,
  availabilityHessian,
  readMomentCovariance,
} from "./rustAvailabilityMoments";
import { actionToIndex, encodeState, requireExport, stockToUses } from "./rustCoreShared";
import { assertRustStatusOk } from "./rustStatus";
import type { RustA2MomentEstimate, RustCoreExports, State, Stock } from "./rustTypes";

export function estimateA2SurrogateFromBuiltPolicy(
  exports: RustCoreExports,
  start: State,
  stock: Stock,
  firstAction: Kit,
  horizonFactor: number,
  normPower: number,
): RustA2MomentEstimate {
  runMomentVector(exports, start, stock, firstAction);
  const mean = {
    blue: requireExport(exports, "momentMeanBUses")() * 10,
    purple: requireExport(exports, "momentMeanPUses")() * 10,
    yellow: requireExport(exports, "momentMeanYUses")() * 10,
  };
  const covariance = readMomentCovariance(exports, mean);
  const baseCost = availabilityCost(mean, stock, horizonFactor, normPower);
  const [hBB, hPP, hYY, hBP, hBY, hPY] = availabilityHessian(mean, stock, horizonFactor, normPower);
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
}

function runMomentVector(exports: RustCoreExports, start: State, stock: Stock, firstAction: Kit) {
  const stateId = encodeState(start.grade, start.level, start.exp ?? 0);
  const stockUses = stockToUses(stock);
  requireExport(exports, "momentVectorAfterFirstActionFromPolicy")(
    stateId,
    stockUses.blue | 0,
    stockUses.purple | 0,
    stockUses.yellow | 0,
    actionToIndex(firstAction),
  );
  assertRustStatusOk(exports, "phase2 A2 moment rollout");
}
