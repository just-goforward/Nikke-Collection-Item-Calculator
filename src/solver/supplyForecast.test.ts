import { describe, expect, it, vi } from "vitest";

import {
  ACTIVE_SUPPLY_FORECAST,
  ACTIVE_SUPPLY_FORECAST_BASE_PROFILE,
  ACTIVE_SUPPLY_FORECAST_BASE_PROFILE_ID,
  ACTIVE_SUPPLY_FORECAST_ID,
  isSupplyForecastId,
  isSupplyForecastProfileId,
  resolveActiveSupplyForecastProfile,
  resolveSupplyForecastProfile,
  SUPPLY_FORECAST_REGISTRY,
} from "../../shared/generated/supplyForecast";
import {
  resolveStagingSupplyForecastProfile,
  STAGING_SUPPLY_FORECAST,
  STAGING_SUPPLY_FORECAST_ID,
} from "../../shared/generated/supplyForecastRuntime";
import { selectedSupplyGain } from "./domain";
import { solve } from "./solve";
import { installSupplyForecastFixtureClock } from "./supplyForecast.test-helper";

installSupplyForecastFixtureClock();

describe("supply forecast registry", () => {
  it("keeps production legacy and approved new-engine pointers independent", () => {
    expect(ACTIVE_SUPPLY_FORECAST_ID).toBe("supply-2026-08-21-v1");
    expect(ACTIVE_SUPPLY_FORECAST.rulesVersion).toBe("legacy-28-day-v1");
    expect(STAGING_SUPPLY_FORECAST_ID).toBe("supply-2026-10-15-v3");
    expect(
      SUPPLY_FORECAST_REGISTRY.forecasts.find(
        (forecast) => forecast.id === STAGING_SUPPLY_FORECAST_ID,
      )?.rulesVersion,
    ).toBe("schedule-kit-v3");
    expect(SUPPLY_FORECAST_REGISTRY.approvedForecastId).toBe(STAGING_SUPPLY_FORECAST_ID);
  });

  it.each(["2026-10-23T00:00:00Z", "2026-12-11T00:00:00Z"])(
    "calculates with the open-ended production profile at %s",
    (at) => {
      vi.setSystemTime(new Date(at));
      const result = solve({
        start: { grade: "SR", level: 14, exp: 2900 },
        stock: { blue: 19, purple: 0, yellow: 0 },
        strategy: "supply",
      });
      expect(result.possible).toBe(true);
      expect(result.best).toBeDefined();
      expect(result.stats?.supplyForecast).toEqual({
        forecastId: "supply-2026-08-21-v1",
        forecastProfileId: "supply-2026-08-21-v1@fixed",
        expectedGain: { blue: 473.912, purple: 55.808, yellow: 24.736 },
        referenceDays: 28,
      });
    },
  );

  it("resolves the active ID to the product solver gains", () => {
    expect(ACTIVE_SUPPLY_FORECAST.id).toBe(ACTIVE_SUPPLY_FORECAST_ID);
    expect(selectedSupplyGain()).toEqual(resolveActiveSupplyForecastProfile().expectedGain);
    expect(isSupplyForecastId(ACTIVE_SUPPLY_FORECAST_ID)).toBe(true);
    expect(isSupplyForecastProfileId(ACTIVE_SUPPLY_FORECAST_BASE_PROFILE_ID)).toBe(true);
    expect(
      resolveSupplyForecastProfile(
        ACTIVE_SUPPLY_FORECAST_ID,
        Date.parse(ACTIVE_SUPPLY_FORECAST_BASE_PROFILE.effectiveFrom),
      ),
    ).toEqual(ACTIVE_SUPPLY_FORECAST_BASE_PROFILE);
    expect(
      resolveActiveSupplyForecastProfile(
        Date.parse(ACTIVE_SUPPLY_FORECAST_BASE_PROFILE.effectiveFrom),
      ),
    ).toEqual(ACTIVE_SUPPLY_FORECAST_BASE_PROFILE);
    expect(isSupplyForecastId("supply-2099-01-01-v1")).toBe(false);
  });

  it("keeps every historical ID unique and recoverable", () => {
    const firstProfile = STAGING_SUPPLY_FORECAST.profiles[0];
    if (!firstProfile) throw new Error("fixture_profile_missing");
    const ids = SUPPLY_FORECAST_REGISTRY.forecasts.map((forecast) => forecast.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(ACTIVE_SUPPLY_FORECAST_ID);
    expect(SUPPLY_FORECAST_REGISTRY.version).toBe(3);
    expect(SUPPLY_FORECAST_REGISTRY.stagingForecastId).toBe(STAGING_SUPPLY_FORECAST_ID);
    expect(STAGING_SUPPLY_FORECAST.id).toBe(STAGING_SUPPLY_FORECAST_ID);
    expect(resolveStagingSupplyForecastProfile(Date.parse(firstProfile.effectiveFrom))).toEqual(
      firstProfile,
    );
  });
});
