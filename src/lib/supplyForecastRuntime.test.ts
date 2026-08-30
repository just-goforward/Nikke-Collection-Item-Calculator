import { beforeAll, describe, expect, it } from "vitest";

import { ACTIVE_SUPPLY_FORECAST_ID } from "../../shared/generated/supplyForecast";
import {
  STAGING_SUPPLY_FORECAST,
  STAGING_SUPPLY_FORECAST_ID,
} from "../../shared/generated/supplyForecastRuntime";
import { activeSupplyForecastContext } from "../wasm/rustCoreShared";
import {
  prepareRuntimeSupplyForecast,
  resolveRuntimeSupplyForecast,
  STAGING_SUPPLY_FORECAST_WORKER_NAME,
  supplyForecastEnvironment,
  supplyForecastWorkerName,
} from "./supplyForecastRuntime";

const STAGING_TIMESTAMP = Date.parse(STAGING_SUPPLY_FORECAST.profiles[0].effectiveFrom);

beforeAll(async () => {
  await prepareRuntimeSupplyForecast("?statsEnv=staging");
});

describe("supply forecast runtime", () => {
  it("keeps the production forecast unless staging is explicitly requested", () => {
    expect(resolveRuntimeSupplyForecast(STAGING_TIMESTAMP, "").forecastId).toBe(
      ACTIVE_SUPPLY_FORECAST_ID,
    );
    expect(resolveRuntimeSupplyForecast(STAGING_TIMESTAMP, "?statsEnv=disabled").forecastId).toBe(
      ACTIVE_SUPPLY_FORECAST_ID,
    );
    expect(supplyForecastEnvironment("?statsEnv=preview")).toBe("production");
  });

  it("uses only the dedicated staging pointer for the staging query", () => {
    const selection = resolveRuntimeSupplyForecast(STAGING_TIMESTAMP, "?statsEnv=staging");
    expect(selection.environment).toBe("staging");
    expect(selection.forecastId).toBe(STAGING_SUPPLY_FORECAST_ID);
    expect(selection.profile.id).toBe(STAGING_SUPPLY_FORECAST.profiles[0].id);
  });

  it("keeps demo statistics on the production forecast", () => {
    expect(
      resolveRuntimeSupplyForecast(STAGING_TIMESTAMP, "?demoStats=1&statsEnv=staging").forecastId,
    ).toBe(ACTIVE_SUPPLY_FORECAST_ID);
  });

  it("passes only the staging selector through the solver worker name", () => {
    expect(supplyForecastWorkerName("?statsEnv=staging&solverBackend=rust-phase2")).toBe(
      STAGING_SUPPLY_FORECAST_WORKER_NAME,
    );
    expect(supplyForecastWorkerName("?statsEnv=disabled")).toBe("collection-solver");
  });

  it("resolves the same staging context inside a worker-like location", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://example.test/assets/worker.js"),
    });
    const originalName = Object.getOwnPropertyDescriptor(globalThis, "name");
    Object.defineProperty(globalThis, "name", {
      configurable: true,
      value: STAGING_SUPPLY_FORECAST_WORKER_NAME,
    });
    try {
      const context = activeSupplyForecastContext();
      const profile = resolveRuntimeSupplyForecast().profile;
      expect(context.forecastId).toBe(STAGING_SUPPLY_FORECAST_ID);
      expect(context.forecastProfileId).toBe(profile.id);
      expect(context.expectedGain).toEqual(profile.expectedGain);
    } finally {
      if (original) Object.defineProperty(globalThis, "location", original);
      else Reflect.deleteProperty(globalThis, "location");
      if (originalName) Object.defineProperty(globalThis, "name", originalName);
      else Reflect.deleteProperty(globalThis, "name");
    }
  });
});
