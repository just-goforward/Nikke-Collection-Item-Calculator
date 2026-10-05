import {
  assertCertifiedSupplySnapshot,
  type CertifiedSupplySnapshot,
} from "../shared/certifiedSupply.ts";
import type { SupplyForecastCandidate } from "../shared/supplyForecastCandidate.ts";

/** Optional only for old approved entries; a present daily contract is always validated. */
export function registryCertifiedSnapshot(entry: unknown): CertifiedSupplySnapshot | undefined {
  if (typeof entry !== "object" || entry === null)
    throw new TypeError("invalid_forecast_registry_entry");
  const snapshot: unknown = Reflect.get(entry, "certifiedSnapshot");
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
