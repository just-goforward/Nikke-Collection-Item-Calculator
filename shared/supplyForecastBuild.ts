import { buildSnapshot } from "./certifiedSupplyBuild.ts";
import type { CertifiedSupplyBuildInput } from "./certifiedSupplyModel.ts";
import { timestamp, withSupplyDateCache } from "./certifiedSupplyModel.ts";
import { GAME_DAY_MS, gameDayStartMs } from "./gameDay.ts";
import { SUPPLY_PROFILE_HORIZON_DAYS, supplyReferenceWindow } from "./supplyForecastProjection.ts";

/** Cover every reference window used by the finite legacy projection horizon. */
export function buildScheduleForecastSnapshot(input: CertifiedSupplyBuildInput) {
  return withSupplyDateCache(() => buildSnapshotForProfiles(input));
}

function buildSnapshotForProfiles(input: CertifiedSupplyBuildInput) {
  const today = gameDayStartMs(timestamp(input.asOf));
  return buildSnapshot(input, (soloRounds) => {
    let until = today + (SUPPLY_PROFILE_HORIZON_DAYS + 1) * GAME_DAY_MS;
    for (let day = 0; day < SUPPLY_PROFILE_HORIZON_DAYS; day += 1) {
      const window = supplyReferenceWindow({ soloRounds }, today + day * GAME_DAY_MS);
      if (window) until = Math.max(until, window.until);
    }
    return (until - today) / GAME_DAY_MS - 1;
  });
}
