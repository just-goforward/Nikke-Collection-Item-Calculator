import { describe, expect, it } from "vitest";
import { buildCertifiedSupplySnapshot } from "../shared/certifiedSupply.ts";
import { LEGACY_CERTIFIED_SUPPLY_LAWS } from "../shared/certifiedSupplyLaws.ts";
import type { SupplyForecastCandidate } from "../shared/supplyForecastCandidate.ts";
import { forecastRegistryEntry } from "./certified-forecast-registry.ts";
import { selectForecastForStagingRuntime } from "./select-staging-forecast.ts";

const snapshot = buildCertifiedSupplySnapshot({
  asOf: "2026-09-30T04:00:00Z",
  revision: "adopted-r1",
  sourceHash: "a".repeat(64),
  soloPeriods: [],
  collaborationPeriods: [],
  sourceStatus: "uncertain",
});
const candidate = {
  forecastId: "supply-2026-09-30-v1",
  rulesVersion: "schedule-kit-v2",
  sourceEvidence: [],
  profiles: [],
  certifiedSnapshot: snapshot,
} as Pick<
  SupplyForecastCandidate,
  "forecastId" | "rulesVersion" | "sourceEvidence" | "profiles" | "certifiedSnapshot"
>;
const base = {
  version: 3,
  activeForecastId: "supply-2026-08-21-v1",
  stagingForecastId: "supply-2026-08-21-v1",
  approvedForecastId: candidate.forecastId,
};
describe("approved staging registry carries the certified daily contract", () => {
  it("preserves historical v1 data but refuses to select it for the v2 runtime", () => {
    const legacy = {
      ...snapshot,
      version: "certified-daily-v1" as const,
      laws: LEGACY_CERTIFIED_SUPPLY_LAWS,
      rules: snapshot.rules.map(({ weeklyFixed: _weeklyFixed, ...rule }) => rule),
      events: snapshot.events.filter((event) => event.kind !== "weekly-kits"),
    };
    const entry = forecastRegistryEntry({ ...candidate, certifiedSnapshot: legacy });
    expect(() =>
      selectForecastForStagingRuntime({ ...base, forecasts: [entry] }, candidate.forecastId),
    ).toThrow("unsupported_forecast_version");
    expect(entry.certifiedSnapshot).toEqual(legacy);
    expect(JSON.stringify(entry.certifiedSnapshot)).toBe(JSON.stringify(legacy));
  });
  it("preserves semantic dates, receipt IDs, exact cadence and coverage through selection", () => {
    const entry = forecastRegistryEntry(candidate);
    const selected = selectForecastForStagingRuntime(
      { ...base, forecasts: [entry] },
      candidate.forecastId,
    );
    expect(selected.forecasts[0]?.certifiedSnapshot).toEqual(snapshot);
    expect(selected.activeForecastId).toBe(base.activeForecastId);
    expect(JSON.parse(JSON.stringify(entry)).certifiedSnapshot.events[0].id).toBe(
      snapshot.events[0]?.id,
    );
  });
  it("rejects an incompatible or malformed optional snapshot before selecting it", () => {
    const bad = {
      ...forecastRegistryEntry(candidate),
      certifiedSnapshot: { ...snapshot, version: "other-schema" },
    };
    expect(() =>
      selectForecastForStagingRuntime({ ...base, forecasts: [bad] }, candidate.forecastId),
    ).toThrow();
  });
});
