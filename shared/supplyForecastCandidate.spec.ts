import { describe, expect, it } from "vitest";
import { assertCertifiedRuntimeSupplySnapshot } from "./certifiedSupply.ts";
import { freezeJson } from "./certifiedSupplyModel.ts";
import { canonicalPublicationJson, publicationHash } from "./forecastPublication.ts";
import { publicationBytesHash } from "./forecastPublicationBytes.ts";
import {
  assertForecastCandidateInvariants,
  buildSupplyForecastCandidate,
  buildV3SupplyForecastCandidate,
  supplyForecastCandidateSchema,
} from "./supplyForecastCandidate.ts";
import registry from "./supplyForecasts.json";

const entry = registry.forecasts.find((forecast) => forecast.id === registry.approvedForecastId);
if (!entry) throw new Error("approved_fixture_missing");
const snapshot = assertCertifiedRuntimeSupplySnapshot(Reflect.get(entry, "certifiedSnapshot"));
const periods = snapshot.soloRounds
  .filter((round) => round.startGameDate > snapshot.coverage.currentDay && round.endGameDate)
  .slice(0, 3)
  .map((round) => ({
    effectiveFrom: `${round.startGameDate}T05:00:00+09:00`,
    effectiveUntil: `${round.endGameDate}T05:00:00+09:00`,
    scheduleStatus: "estimated" as const,
  }));
const primary = periods[0];
if (!primary) throw new Error("schedule_fixture_missing");
const candidate = {
  payloadVersion: 4,
  candidateId: "forecast-v3-regression-fixture",
  forecastId: entry.id,
  rulesVersion: "schedule-kit-v3",
  dispatchPolicyId: "dispatch-policy-v1",
  generatedAt: snapshot.asOf,
  sourceStatus: "x_unavailable",
  schedule: {
    status: "estimated",
    cadenceDays: null,
    soloStart: primary.effectiveFrom,
    soloEnd: primary.effectiveUntil,
    soloPeriods: periods,
    collaborationPeriods: [],
  },
  sourceEvidence: entry.sourceEvidence,
  profiles: entry.profiles,
  warnings: [],
  certifiedSnapshot: snapshot,
};

describe("versioned forecast payload admission", () => {
  it("preserves candidate bytes with frozen projection reuse and revalidates fresh bytes", () => {
    const admitted = supplyForecastCandidateSchema.parse(candidate);
    const mutable = structuredClone(snapshot);
    const expected = buildV3SupplyForecastCandidate({ ...admitted, certifiedSnapshot: mutable });
    const frozen = freezeJson(structuredClone(snapshot));
    const actual = buildV3SupplyForecastCandidate({ ...admitted, certifiedSnapshot: frozen });
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    const tampered = JSON.parse(JSON.stringify(actual));
    tampered.profiles[0].expectedGain.blue += 1;
    expect(supplyForecastCandidateSchema.safeParse(tampered).success).toBe(false);
    const second = buildV3SupplyForecastCandidate({ ...admitted, certifiedSnapshot: frozen });
    expect(JSON.stringify(second)).toBe(JSON.stringify(expected));
  });
  it("writes payload 5 for v4 while preserving payload 4 reconstruction", () => {
    const historical = supplyForecastCandidateSchema.parse(candidate);
    const current = buildSupplyForecastCandidate({
      ...historical,
      certifiedSnapshot: { ...snapshot, version: "certified-daily-v4" },
      grants: [],
      schedule: {
        ...historical.schedule,
        soloPeriods: historical.schedule.soloPeriods.map((period) => {
          const round = snapshot.soloRounds.find(
            (entry) => entry.startGameDate === period.effectiveFrom.slice(0, 10),
          );
          if (!round) throw new Error("fixture_round_missing");
          return { ...period, round: round.round, segment: 1 };
        }),
      },
    });
    expect(current.payloadVersion).toBe(5);
    expect(current.rulesVersion).toBe("schedule-kit-v4");
    expect(current.certifiedSnapshot.version).toBe("certified-daily-v4");
    expect(buildV3SupplyForecastCandidate({ ...historical, certifiedSnapshot: snapshot })).toEqual(
      historical,
    );
  });
  it("constructs canonical v3 profiles internally while retaining metadata and runtime guards", () => {
    const admitted = supplyForecastCandidateSchema.parse(candidate);
    expect(buildV3SupplyForecastCandidate({ ...admitted, certifiedSnapshot: snapshot })).toEqual(
      admitted,
    );
    expect(() =>
      buildV3SupplyForecastCandidate({
        ...admitted,
        certifiedSnapshot: snapshot,
        sourceEvidence: admitted.sourceEvidence.map((source) => ({
          ...source,
          url: "https://example.com/unapproved",
        })),
      }),
    ).toThrow("Source URL is not allowlisted");
    expect(() =>
      buildV3SupplyForecastCandidate({
        ...admitted,
        certifiedSnapshot: {
          ...snapshot,
          version: "certified-daily-v2",
          rules: snapshot.rules.map(({ weeklyFixed: _weeklyFixed, ...rule }) => rule),
          events: snapshot.events.filter((event) => event.kind !== "weekly-kits"),
        },
      }),
    ).toThrow("unsupported_forecast_version");
    expect(() =>
      buildV3SupplyForecastCandidate({
        ...admitted,
        certifiedSnapshot: snapshot,
        schedule: { ...admitted.schedule, soloEnd: admitted.schedule.soloStart },
      }),
    ).toThrow("Solo Raid schedule is inverted");
  });

  it("requires the approved v3 ledger and exactly its finite-window projection", () => {
    const parsed = supplyForecastCandidateSchema.parse(candidate);
    expect(() => assertForecastCandidateInvariants(parsed)).not.toThrow();
    expect(
      supplyForecastCandidateSchema.safeParse({ ...candidate, certifiedSnapshot: undefined })
        .success,
    ).toBe(false);
    expect(
      supplyForecastCandidateSchema.safeParse({ ...candidate, payloadVersion: 3 }).success,
    ).toBe(false);
    const first = candidate.profiles[0];
    if (!first) throw new Error("profile_fixture_missing");
    expect(
      supplyForecastCandidateSchema.safeParse({
        ...candidate,
        profiles: [
          { ...first, expectedGain: { ...first.expectedGain, blue: first.expectedGain.blue + 1 } },
          ...candidate.profiles.slice(1),
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a v3 law shadow before admitting the forecast", () => {
    expect(
      supplyForecastCandidateSchema.safeParse({
        ...candidate,
        certifiedSnapshot: {
          ...snapshot,
          laws: snapshot.laws.map((law) =>
            law.id === "dispatch-board-v1"
              ? {
                  id: law.id,
                  kind: "finite",
                  modelVersion: "shadow",
                  outcomes: [{ pieces: [99, 0, 0], mass: { numerator: "1", denominator: "1" } }],
                }
              : law,
          ),
        },
      }).success,
    ).toBe(false);
  });

  it("rejects ledger grants and period round/segment fields before v4 snapshots", () => {
    const historical = registry.forecasts.find(
      (forecast) => forecast.rulesVersion === "schedule-kit-v2",
    );
    if (!historical) throw new Error("historical_fixture_missing");
    const legacy = {
      ...candidate,
      payloadVersion: 3,
      forecastId: historical.id,
      rulesVersion: historical.rulesVersion,
      profiles: historical.profiles,
      certifiedSnapshot: undefined,
    };
    for (const base of [candidate, legacy]) {
      expect(supplyForecastCandidateSchema.safeParse(base).success).toBe(true);
      const withPeriods = (extra: object) => ({
        ...base,
        schedule: {
          ...base.schedule,
          soloPeriods: base.schedule.soloPeriods.map((period) => ({ ...period, ...extra })),
        },
      });
      for (const rejected of [
        { ...base, grants: [] },
        withPeriods({ round: 1 }),
        withPeriods({ segment: 1 }),
        withPeriods({ round: 1, segment: 1 }),
      ])
        expect(supplyForecastCandidateSchema.safeParse(rejected).success).toBe(false);
    }
  });

  it("parses historical v3 candidate bytes unchanged under the stricter schema", async () => {
    expect(snapshot.version).toBe("certified-daily-v3");
    const bytes = canonicalPublicationJson(
      buildV3SupplyForecastCandidate({ ...candidate, certifiedSnapshot: snapshot }),
    );
    const parsed = supplyForecastCandidateSchema.parse(JSON.parse(bytes));
    expect(parsed.payloadVersion).toBe(4);
    expect(parsed.grants).toBeUndefined();
    expect(canonicalPublicationJson(parsed)).toBe(bytes);
    expect(await publicationHash(parsed)).toBe(await publicationBytesHash(bytes));
    expect(() => assertForecastCandidateInvariants(parsed)).not.toThrow();
  });

  it("keeps historical payload-v3/schedule-v2 entries readable without a ledger", () => {
    const historical = registry.forecasts.find(
      (forecast) => forecast.rulesVersion === "schedule-kit-v2",
    );
    if (!historical) throw new Error("historical_fixture_missing");
    const parsed = supplyForecastCandidateSchema.parse({
      ...candidate,
      payloadVersion: 3,
      forecastId: historical.id,
      rulesVersion: historical.rulesVersion,
      profiles: historical.profiles,
      certifiedSnapshot: undefined,
    });
    expect(parsed.profiles).toEqual(historical.profiles);
    expect(() => assertForecastCandidateInvariants(parsed)).not.toThrow();
  });
});
