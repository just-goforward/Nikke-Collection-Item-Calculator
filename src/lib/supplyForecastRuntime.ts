import {
  ACTIVE_SUPPLY_FORECAST_ID,
  resolveActiveSupplyForecastProfile,
  type SupplyForecastProfile,
} from "../../shared/generated/supplyForecast";

type StagingForecastModule = typeof import("../../shared/generated/supplyForecastRuntime");

export type SupplyForecastEnvironment = "production" | "staging";

export type RuntimeSupplyForecast = {
  environment: SupplyForecastEnvironment;
  forecastId: string;
  profile: SupplyForecastProfile;
};

export const STAGING_SUPPLY_FORECAST_WORKER_NAME = "collection-solver:staging";

let stagingForecastModule: StagingForecastModule | null = null;
let stagingForecastModulePromise: Promise<void> | null = null;

function currentSearch() {
  if (
    typeof document === "undefined" &&
    Reflect.get(globalThis, "name") === STAGING_SUPPLY_FORECAST_WORKER_NAME
  ) {
    return "?statsEnv=staging";
  }
  if (typeof globalThis.location !== "object") return "";
  return globalThis.location.search;
}

export function supplyForecastEnvironment(search = currentSearch()): SupplyForecastEnvironment {
  const params = new URLSearchParams(search);
  if (params.get("demoStats") === "1") return "production";
  return params.get("statsEnv") === "staging" ? "staging" : "production";
}

export function resolveRuntimeSupplyForecast(
  timestampMs = Date.now(),
  search = currentSearch(),
): RuntimeSupplyForecast {
  if (supplyForecastEnvironment(search) === "staging") {
    if (!stagingForecastModule) {
      throw new Error("The staging supply forecast was not prepared before use.");
    }
    return {
      environment: "staging",
      forecastId: stagingForecastModule.STAGING_SUPPLY_FORECAST_ID,
      profile: stagingForecastModule.resolveStagingSupplyForecastProfile(timestampMs),
    };
  }
  return {
    environment: "production",
    forecastId: ACTIVE_SUPPLY_FORECAST_ID,
    profile: resolveActiveSupplyForecastProfile(timestampMs),
  };
}

export function prepareRuntimeSupplyForecast(search = currentSearch()) {
  if (supplyForecastEnvironment(search) !== "staging" || stagingForecastModule) return null;
  stagingForecastModulePromise ??= import("../../shared/generated/supplyForecastRuntime").then(
    (module) => {
      stagingForecastModule = module;
    },
  );
  return stagingForecastModulePromise;
}

export function supplyForecastWorkerName(search = currentSearch()) {
  return supplyForecastEnvironment(search) === "staging"
    ? STAGING_SUPPLY_FORECAST_WORKER_NAME
    : "collection-solver";
}
