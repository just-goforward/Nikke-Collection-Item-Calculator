import type { CertifiedSupplyBuildInput } from "./certifiedSupply.ts";
import { CERTIFIED_SUPPLY_HISTORY_DAYS } from "./certifiedSupplyModel.ts";
import { SOLO_RAID_ROUND_HISTORY } from "./soloRaidCadence.ts";
import { buildScheduleForecastSnapshot } from "./supplyForecastBuild.ts";
import { buildScheduleForecastProfiles, SUPPLY_RULES_VERSION } from "./supplyForecastProjection.ts";

export const BUNDLED_V3_FORECAST_ID = "supply-2026-10-15-v3";
export const BUNDLED_V3_AS_OF = "2026-10-14T20:00:00.000Z";

/** Only dates already quoted by the approved notice IDs are confirmed here. */
export function bundledV3SupplyInput(
  sourceEvidence: readonly { itemId: string; url: string }[],
  sourceHash: string,
): CertifiedSupplyBuildInput {
  const ids = new Set(sourceEvidence.map((source) => source.itemId));
  if (!ids.has("8060044") || !ids.has("8031679"))
    throw new Error("bundled_forecast_approved_evidence_missing");
  return {
    asOf: BUNDLED_V3_AS_OF,
    revision: `${BUNDLED_V3_FORECAST_ID}:${sourceHash.slice(0, 16)}`,
    sourceHash,
    sourceStatus: "uncertain",
    confirmedRounds: SOLO_RAID_ROUND_HISTORY,
    soloPeriods: [
      {
        round: 40,
        effectiveFrom: "2026-08-20T03:00:00.000Z",
        effectiveUntil: "2026-08-26T19:59:00.000Z",
        scheduleStatus: "confirmed",
      },
    ],
    collaborationPeriods: [
      {
        effectiveFrom: "2026-08-19T20:00:00.000Z",
        effectiveUntil: "2026-09-09T19:59:00.000Z",
      },
    ],
    provenance: [
      "approved_legacy_registry_seed",
      "FRP-v3.1:Wednesday-fixed-10-blue-10-purple",
      `history_limit:${CERTIFIED_SUPPLY_HISTORY_DAYS}`,
      ...sourceEvidence.map((source) => source.url),
    ],
  };
}

export function buildBundledV3Forecast(
  sourceEvidence: readonly { itemId: string; url: string }[],
  sourceHash: string,
) {
  const input = bundledV3SupplyInput(sourceEvidence, sourceHash);
  const certifiedSnapshot = buildScheduleForecastSnapshot(input);
  return {
    id: BUNDLED_V3_FORECAST_ID,
    kind: "schedule" as const,
    rulesVersion: SUPPLY_RULES_VERSION,
    effectiveFrom: "2026-10-15",
    sourceEvidence,
    profiles: buildScheduleForecastProfiles({
      forecastId: BUNDLED_V3_FORECAST_ID,
      effectiveFrom: input.asOf,
      certifiedSnapshot,
    }),
    certifiedSnapshot,
  };
}
