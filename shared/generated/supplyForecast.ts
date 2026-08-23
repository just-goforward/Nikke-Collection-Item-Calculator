// Generated from shared/supplyForecasts.json. Do not edit directly.
export const SUPPLY_FORECAST_REGISTRY = {
  version: 1,
  activeForecastId: "supply-2026-08-21-v1",
  forecasts: [
    {
      id: "supply-2026-08-21-v1",
      basisDays: 28,
      effectiveFrom: "2026-08-21",
      expectedGain: {
        blue: 473.912,
        purple: 55.808,
        yellow: 24.736,
      },
    },
  ],
} as const;

export const ACTIVE_SUPPLY_FORECAST_ID = SUPPLY_FORECAST_REGISTRY.activeForecastId;
export const ACTIVE_SUPPLY_FORECAST = SUPPLY_FORECAST_REGISTRY.forecasts[0];

export type SupplyForecastId = (typeof SUPPLY_FORECAST_REGISTRY.forecasts)[number]["id"];

export function isSupplyForecastId(value: unknown): value is SupplyForecastId {
  return (SUPPLY_FORECAST_REGISTRY.forecasts as readonly { id: string }[]).some(
    (forecast) => forecast.id === value,
  );
}
