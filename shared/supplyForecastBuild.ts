import { buildCertifiedSupplySnapshot, type CertifiedSupplyBuildInput } from "./certifiedSupply.ts";
import { GAME_DAY_MS, gameDayStartMs } from "./gameDay.ts";
import { SUPPLY_PROFILE_HORIZON_DAYS, supplyReferenceWindow } from "./supplyForecastProjection.ts";

/** Cover every reference window used by the finite legacy projection horizon. */
export function buildScheduleForecastSnapshot(input: CertifiedSupplyBuildInput) {
  const seed = buildCertifiedSupplySnapshot(input);
  const today = gameDayStartMs(Date.parse(input.asOf));
  let until = today + (SUPPLY_PROFILE_HORIZON_DAYS + 1) * GAME_DAY_MS;
  for (let day = 0; day < SUPPLY_PROFILE_HORIZON_DAYS; day += 1) {
    const window = supplyReferenceWindow(seed, today + day * GAME_DAY_MS);
    if (window) until = Math.max(until, window.until);
  }
  return buildCertifiedSupplySnapshot({
    ...input,
    horizonDays: (until - today) / GAME_DAY_MS - 1,
  });
}
