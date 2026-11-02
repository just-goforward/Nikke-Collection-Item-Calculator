import { assertCertifiedRuntimeSupplySnapshot } from "../../shared/certifiedSupply.ts";
import { buildV3SupplyForecastCandidate } from "../../shared/supplyForecastCandidate.ts";
import registry from "../../shared/supplyForecasts.json";

// Local schema fixture, NOT a staging payload. Live staging fixture retrieval is
// separately required; these tests must not claim that generated data is evidence.
const entry = registry.forecasts.find((value) => value.id === registry.approvedForecastId);
if (!entry) throw new Error("approved_fixture_missing");
export const snapshot = assertCertifiedRuntimeSupplySnapshot(
  Reflect.get(entry, "certifiedSnapshot"),
);
const soloPeriods = snapshot.soloRounds
  .filter((round) => round.startGameDate > snapshot.coverage.currentDay && round.endGameDate)
  .slice(0, 3)
  .map((round) => ({
    effectiveFrom: `${round.startGameDate}T05:00:00+09:00`,
    effectiveUntil: `${round.endGameDate}T05:00:00+09:00`,
    scheduleStatus: "estimated" as const,
  }));
const primary = soloPeriods[0];
if (!primary) throw new Error("period_fixture_missing");
export const fixtureCandidate = buildV3SupplyForecastCandidate({
  candidateId: "forecast-publication-render-fixture",
  forecastId: entry.id,
  generatedAt: snapshot.asOf,
  sourceStatus: "x_unavailable",
  dispatchPolicyId: "dispatch-policy-v1",
  schedule: {
    status: "estimated",
    cadenceDays: null,
    soloStart: primary.effectiveFrom,
    soloEnd: primary.effectiveUntil,
    soloPeriods,
    collaborationPeriods: [],
  },
  sourceEvidence: entry.sourceEvidence,
  warnings: [],
  certifiedSnapshot: snapshot,
});
