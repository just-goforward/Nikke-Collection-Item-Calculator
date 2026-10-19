import { describe, expect, it } from "vitest";
import { buildCertifiedSupplySnapshot } from "../shared/certifiedSupply.ts";
import { LEGACY_CERTIFIED_SUPPLY_LAWS } from "../shared/certifiedSupplyLaws.ts";
import type { SupplyForecastCandidate } from "../shared/supplyForecastCandidate.ts";
import { forecastRegistryEntry } from "./certified-forecast-registry.ts";

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
describe("approved staging registry carries the certified daily contract", () => {
  it("preserves historical v1 snapshot bytes", () => {
    const legacy = {
      ...snapshot,
      version: "certified-daily-v1" as const,
      laws: LEGACY_CERTIFIED_SUPPLY_LAWS,
      rules: snapshot.rules.map(({ weeklyFixed: _weeklyFixed, ...rule }) => rule),
      events: snapshot.events.filter((event) => event.kind !== "weekly-kits"),
    };
    const entry = forecastRegistryEntry({ ...candidate, certifiedSnapshot: legacy });
    expect(entry.certifiedSnapshot).toEqual(legacy);
    expect(JSON.stringify(entry.certifiedSnapshot)).toBe(JSON.stringify(legacy));
  });
  it("preserves semantic dates, receipt IDs, exact cadence and coverage byte-for-byte", () => {
    const entry = forecastRegistryEntry(candidate);
    expect(entry.certifiedSnapshot).toEqual(snapshot);
    expect(JSON.stringify(entry.certifiedSnapshot)).toBe(JSON.stringify(snapshot));
    expect(JSON.parse(JSON.stringify(entry)).certifiedSnapshot.events[0].id).toBe(
      snapshot.events[0]?.id,
    );
  });
  it("rejects a malformed optional snapshot", () => {
    const bad = {
      ...candidate,
      certifiedSnapshot: { ...snapshot, asOf: "not-a-date" },
    };
    expect(() => forecastRegistryEntry(bad)).toThrow();
  });
});
