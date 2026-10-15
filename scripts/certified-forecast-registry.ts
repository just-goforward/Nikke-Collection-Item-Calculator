import {
  assertCertifiedSupplySnapshot,
  type CertifiedSupplySnapshot,
} from "../shared/certifiedSupply.ts";
import type { SupplyForecastCandidate } from "../shared/supplyForecastCandidate.ts";
import {
  assertLedgerForecastProfiles,
  type SupplyForecastProfile,
} from "../shared/supplyForecastProjection.ts";

/** Optional only for old approved entries; a present daily contract is always validated. */
export function registryCertifiedSnapshot(entry: unknown): CertifiedSupplySnapshot | undefined {
  if (typeof entry !== "object" || entry === null)
    throw new TypeError("invalid_forecast_registry_entry");
  const snapshot: unknown = Reflect.get(entry, "certifiedSnapshot");
  if (Reflect.get(entry, "rulesVersion") === "schedule-kit-v3") {
    const parsed = assertCertifiedSupplySnapshot(snapshot);
    const id = Reflect.get(entry, "id") ?? Reflect.get(entry, "forecastId");
    const profiles: unknown = Reflect.get(entry, "profiles");
    if (typeof id !== "string" || !Array.isArray(profiles))
      throw new Error("v3_forecast_profiles_required");
    assertLedgerForecastProfiles(id, parsed, profiles as SupplyForecastProfile[]);
    return parsed;
  }
  return snapshot === undefined ? undefined : assertCertifiedSupplySnapshot(snapshot);
}

export function forecastRegistryEntry(
  candidate: Pick<
    SupplyForecastCandidate,
    "forecastId" | "rulesVersion" | "sourceEvidence" | "profiles" | "certifiedSnapshot"
  >,
) {
  const certifiedSnapshot = registryCertifiedSnapshot(candidate);
  return {
    id: candidate.forecastId,
    kind: "schedule" as const,
    rulesVersion: candidate.rulesVersion,
    effectiveFrom: candidate.forecastId.slice("supply-".length, "supply-YYYY-MM-DD".length),
    sourceEvidence: candidate.sourceEvidence,
    profiles: candidate.profiles,
    ...(certifiedSnapshot ? { certifiedSnapshot } : {}),
  };
}
