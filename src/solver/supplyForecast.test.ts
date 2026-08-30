import { describe, expect, it } from "vitest";

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
import { EXPECTED_28_DAY_GAIN } from "./domain";

describe("supply forecast registry", () => {
  it("resolves the active ID to the product solver gains", () => {
    expect(ACTIVE_SUPPLY_FORECAST.id).toBe(ACTIVE_SUPPLY_FORECAST_ID);
    expect(EXPECTED_28_DAY_GAIN).toEqual(ACTIVE_SUPPLY_FORECAST_BASE_PROFILE.expectedGain);
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
    const ids = SUPPLY_FORECAST_REGISTRY.forecasts.map((forecast) => forecast.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(ACTIVE_SUPPLY_FORECAST_ID);
    expect(SUPPLY_FORECAST_REGISTRY.version).toBe(3);
    expect(SUPPLY_FORECAST_REGISTRY.stagingForecastId).toBe(STAGING_SUPPLY_FORECAST_ID);
    expect(STAGING_SUPPLY_FORECAST.id).toBe(STAGING_SUPPLY_FORECAST_ID);
    expect(
      resolveStagingSupplyForecastProfile(
        Date.parse(STAGING_SUPPLY_FORECAST.profiles[0].effectiveFrom),
      ),
    ).toEqual(STAGING_SUPPLY_FORECAST.profiles[0]);
  });
});
