import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { assertCertifiedRuntimeSupplySnapshot } from "../../shared/certifiedSupply";
import { CERTIFIED_APPROVED_FORECAST } from "../../shared/generated/certifiedForecastAuthority";
import { ACTIVE_SUPPLY_FORECAST_ID } from "../../shared/generated/supplyForecast";
import {
  STAGING_SUPPLY_FORECAST,
  STAGING_SUPPLY_FORECAST_ID,
} from "../../shared/generated/supplyForecastRuntime";
import { STAGING_RUNTIME_SEARCH } from "../../shared/runtimeEnvironment";
import { assertLedgerForecastProfiles } from "../../shared/supplyForecastProjection";
import { activeSupplyForecastContext } from "../wasm/rustCoreShared";
import {
  prepareRuntimeSupplyForecast,
  resolveRuntimeSupplyForecast,
  STAGING_SUPPLY_FORECAST_WORKER_NAME,
  SUPPLY_UNAVAILABLE_MESSAGE,
  supplyForecastEnvironment,
  supplyForecastWorkerName,
} from "./supplyForecastRuntime";

const firstProfile = STAGING_SUPPLY_FORECAST.profiles[0];
if (!firstProfile) throw new Error("fixture_profile_missing");
const STAGING_TIMESTAMP = Date.parse(firstProfile.effectiveFrom);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(STAGING_TIMESTAMP);
  await prepareRuntimeSupplyForecast("");
  await prepareRuntimeSupplyForecast(STAGING_RUNTIME_SEARCH);
});
afterAll(() => vi.useRealTimers());

describe("supply forecast runtime", () => {
  it("boots production synchronously from generated profiles without ledger preparation", () => {
    expect(prepareRuntimeSupplyForecast("")).toBeNull();
    expect(prepareRuntimeSupplyForecast("?statsEnv=staging&demoStats=1")).toBeNull();
  });
  it("ships staging profiles identical to the exact approved-ledger projection", () => {
    const snapshot = assertCertifiedRuntimeSupplySnapshot(
      Reflect.get(CERTIFIED_APPROVED_FORECAST, "certifiedSnapshot"),
    );
    expect(() =>
      assertLedgerForecastProfiles(
        STAGING_SUPPLY_FORECAST_ID,
        snapshot,
        STAGING_SUPPLY_FORECAST.profiles,
      ),
    ).not.toThrow();
  });
  it("refuses unavailable and expired staging windows instead of returning partial gains", () => {
    expect(() =>
      resolveRuntimeSupplyForecast(Date.parse("2026-10-22T05:00:00+09:00"), STAGING_RUNTIME_SEARCH),
    ).toThrow(SUPPLY_UNAVAILABLE_MESSAGE);
    expect(() =>
      resolveRuntimeSupplyForecast(Date.parse("2027-01-01T05:00:00+09:00"), STAGING_RUNTIME_SEARCH),
    ).toThrow(SUPPLY_UNAVAILABLE_MESSAGE);
  });
  it.each(["2026-10-23T00:00:00Z", "2026-12-11T00:00:00Z"])(
    "keeps production on the open-ended v1 profile at %s",
    (at) => {
      expect(resolveRuntimeSupplyForecast(Date.parse(at), "")).toMatchObject({
        environment: "production",
        forecastId: "supply-2026-08-21-v1",
        profile: {
          id: "supply-2026-08-21-v1@fixed",
          effectiveUntil: null,
          expectedGain: { blue: 473.912, purple: 55.808, yellow: 24.736 },
        },
      });
    },
  );
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
    const selection = resolveRuntimeSupplyForecast(STAGING_TIMESTAMP, STAGING_RUNTIME_SEARCH);
    expect(selection.environment).toBe("staging");
    expect(selection.forecastId).toBe(STAGING_SUPPLY_FORECAST_ID);
    expect(selection.profile.id).toBe(firstProfile.id);
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
