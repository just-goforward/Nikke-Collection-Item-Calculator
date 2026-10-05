import { certifiedForecastIdentityWorkspaceBound } from "../../shared/certifiedForecastIdentity";
import {
  assertCertifiedSupplySnapshot,
  buildCertifiedSupplySnapshot,
  type CertifiedSupplySnapshot,
  viewCertifiedSupplySnapshot,
} from "../../shared/certifiedSupply";
import { CERTIFIED_FORECAST_SEED_PROVENANCE_HASH } from "../../shared/generated/certifiedEngineBuild";
import {
  CERTIFIED_APPROVED_FORECAST,
  CERTIFIED_APPROVED_REGISTRY_HASH,
} from "../../shared/generated/certifiedForecastAuthority";
import { SOLO_RAID_ROUND_HISTORY } from "../../shared/soloRaidCadence";

/** Fixed seed: 113 game days, three cohorts and the pinned 40-round history.
 * Reserve construction, hashing and temporary copies before rebuilding it.
 * A future adopted ledger also reserves its measured structural upper bound.
 */
export function certifiedForecastBuildWorkspaceBound(): number {
  const adopted = CERTIFIED_APPROVED_FORECAST;
  const rawSnapshot: unknown = Reflect.get(adopted, "certifiedSnapshot");
  return (
    4 * 1024 * 1024 +
    (rawSnapshot === undefined
      ? 0
      : 8 * certifiedForecastIdentityWorkspaceBound(assertCertifiedSupplySnapshot(rawSnapshot)))
  );
}

/** Existing approved registry entries predate the event ledger. This explicit seed preserves that provenance. */
export async function prepareCertifiedForecast(
  asOf = new Date().toISOString(),
): Promise<CertifiedSupplySnapshot> {
  const adopted = CERTIFIED_APPROVED_FORECAST;
  const rawSnapshot: unknown = Reflect.get(adopted, "certifiedSnapshot");
  if (rawSnapshot !== undefined)
    return viewCertifiedSupplySnapshot(assertCertifiedSupplySnapshot(rawSnapshot), asOf);
  const acceptedSourceIds = new Set(adopted.sourceEvidence.map((source) => source.itemId));
  // Dates below are quoted by the accepted source IDs, not matched to a nearest estimate.
  const soloPeriods = acceptedSourceIds.has("8060044")
    ? [
        {
          round: 40,
          effectiveFrom: "2026-08-20T03:00:00.000Z",
          effectiveUntil: "2026-08-26T19:59:00.000Z",
          scheduleStatus: "confirmed" as const,
        },
      ]
    : [];
  const collaborationPeriods = acceptedSourceIds.has("8031679")
    ? [
        {
          effectiveFrom: "2026-08-19T20:00:00.000Z",
          effectiveUntil: "2026-09-09T19:59:00.000Z",
        },
      ]
    : [];
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({
        adopted,
        fullApprovedRegistryHash: CERTIFIED_APPROVED_REGISTRY_HASH,
        rounds: SOLO_RAID_ROUND_HISTORY,
        modelVersion: "documented-physical-supply-v1",
        soloPeriods,
        collaborationPeriods,
        seedProvenanceHash: CERTIFIED_FORECAST_SEED_PROVENANCE_HASH,
      }),
    ),
  );
  const sourceHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return buildCertifiedSupplySnapshot({
    asOf,
    revision: `${adopted.id}:${sourceHash.slice(0, 16)}`,
    sourceHash,
    soloPeriods,
    collaborationPeriods,
    confirmedRounds: SOLO_RAID_ROUND_HISTORY,
    // A static approved registry proves sources, not the health of today's collection.
    sourceStatus: "uncertain",
    provenance: [
      "approved_legacy_registry_seed",
      `official_source_manifest:${CERTIFIED_FORECAST_SEED_PROVENANCE_HASH}`,
      ...adopted.sourceEvidence.map((source) => source.url),
      "round_40_period_from_official_full_text_8060044",
      "past_effective_reward_rules_unavailable",
    ],
  });
}
