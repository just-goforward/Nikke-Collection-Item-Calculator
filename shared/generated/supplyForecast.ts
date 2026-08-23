// Generated from shared/supplyForecasts.json. Do not edit directly.
export const SUPPLY_FORECAST_REGISTRY =
  {
    "version": 2,
    "activeForecastId": "supply-2026-08-21-v1",
    "approvedForecastId": "supply-2026-08-21-v1",
    "forecasts": [
      {
        "id": "supply-2026-08-21-v1",
        "kind": "fixed",
        "rulesVersion": "legacy-28-day-v1",
        "effectiveFrom": "2026-08-21",
        "sourceEvidence": [],
        "profiles": [
          {
            "id": "supply-2026-08-21-v1@fixed",
            "effectiveFrom": "2026-08-21T00:00:00.000Z",
            "effectiveUntil": null,
            "scheduleStatus": "confirmed",
            "expectedGain": {
              "blue": 473.912,
              "purple": 55.808,
              "yellow": 24.736
            }
          }
        ]
      }
    ]
  } as const;

export const ACTIVE_SUPPLY_FORECAST_ID = SUPPLY_FORECAST_REGISTRY.activeForecastId;
export const ACTIVE_SUPPLY_FORECAST = SUPPLY_FORECAST_REGISTRY.forecasts[0];

export type SupplyForecastId = (typeof SUPPLY_FORECAST_REGISTRY.forecasts)[number]["id"];
export type SupplyForecastProfile = {
  id: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  scheduleStatus: "confirmed" | "estimated";
  expectedGain: { blue: number; purple: number; yellow: number };
};

export function isSupplyForecastId(value: unknown): value is SupplyForecastId {
  return (SUPPLY_FORECAST_REGISTRY.forecasts as readonly { id: string }[]).some(
    (forecast) => forecast.id === value,
  );
}

export function isSupplyForecastProfileId(value: unknown): value is string {
  return SUPPLY_FORECAST_REGISTRY.forecasts.some((forecast) =>
    forecast.profiles.some((profile) => profile.id === value),
  );
}

export function resolveSupplyForecastProfile(
  forecastId: string,
  timestampMs = Date.now(),
): SupplyForecastProfile | null {
  const forecast = SUPPLY_FORECAST_REGISTRY.forecasts.find((entry) => entry.id === forecastId);
  if (!forecast) return null;
  return (forecast.profiles as readonly SupplyForecastProfile[]).find((profile) => {
    const from = Date.parse(profile.effectiveFrom);
    const until = profile.effectiveUntil === null ? Number.POSITIVE_INFINITY : Date.parse(profile.effectiveUntil);
    return timestampMs >= from && timestampMs < until;
  }) ?? null;
}

const activeProfile = resolveSupplyForecastProfile(ACTIVE_SUPPLY_FORECAST_ID);
if (!activeProfile) throw new Error("The active supply forecast has no profile for the current time.");
export const ACTIVE_SUPPLY_FORECAST_PROFILE = activeProfile;
export const ACTIVE_SUPPLY_FORECAST_PROFILE_ID = activeProfile.id;
