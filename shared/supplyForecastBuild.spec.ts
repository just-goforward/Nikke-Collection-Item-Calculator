import { describe, expect, it } from "vitest";
import { buildCertifiedSupplySnapshot, type CertifiedSupplyBuildInput } from "./certifiedSupply.ts";
import { GAME_DAY_MS, gameDayStartMs } from "./gameDay.ts";
import { buildScheduleForecastSnapshot } from "./supplyForecastBuild.ts";
import { SUPPLY_PROFILE_HORIZON_DAYS, supplyReferenceWindow } from "./supplyForecastProjection.ts";

describe("reference-horizon snapshot construction", () => {
  it.each([56, 112, 366])("matches two-pass ledger JSON for seed horizon %i", (horizonDays) => {
    const input: CertifiedSupplyBuildInput = {
      asOf: "2026-08-20T12:00:00Z",
      revision: "horizon-parity",
      sourceHash: "a".repeat(64),
      horizonDays,
      soloPeriods: [
        {
          round: 40,
          effectiveFrom: "2026-08-20T12:00:00+09:00",
          effectiveUntil: "2026-08-27T04:59:00+09:00",
          scheduleStatus: "confirmed",
        },
      ],
      collaborationPeriods: [],
    };
    const seed = buildCertifiedSupplySnapshot(input);
    const today = gameDayStartMs(Date.parse(input.asOf));
    let until = today + (SUPPLY_PROFILE_HORIZON_DAYS + 1) * GAME_DAY_MS;
    for (let day = 0; day < SUPPLY_PROFILE_HORIZON_DAYS; day += 1) {
      const window = supplyReferenceWindow(seed, today + day * GAME_DAY_MS);
      if (window) until = Math.max(until, window.until);
    }
    const expected = buildCertifiedSupplySnapshot({
      ...input,
      horizonDays: (until - today) / GAME_DAY_MS - 1,
    });
    const actual = buildScheduleForecastSnapshot(input);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    expect(Object.isFrozen(actual.events)).toBe(true);
  });
});
