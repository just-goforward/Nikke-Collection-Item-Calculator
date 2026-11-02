/** Version dispatch is explicit: unknown inputs never inherit legacy privileges. */
export const CERTIFIED_SNAPSHOT_VERSIONS = [
  "certified-daily-v1",
  "certified-daily-v2",
  "certified-daily-v3",
  "certified-daily-v4",
  "certified-daily-v5",
] as const;

export type CertifiedSnapshotVersion = (typeof CERTIFIED_SNAPSHOT_VERSIONS)[number];

export const CURRENT_CERTIFIED_SNAPSHOT_VERSION = "certified-daily-v5" as const;
export const CURRENT_FORECAST_PAYLOAD_VERSION = 6 as const;
export const CURRENT_FORECAST_RULES_VERSION = "schedule-kit-v5" as const;
export const FORECAST_PAYLOAD_VERSIONS = [3, 4, 5, 6] as const;
export const FORECAST_RULES_VERSIONS = [
  "schedule-kit-v2",
  "schedule-kit-v3",
  "schedule-kit-v4",
  "schedule-kit-v5",
] as const;

export function isForecastRulesVersion(value: unknown): boolean {
  return FORECAST_RULES_VERSIONS.some((version) => value === version);
}

export function usesLedgerForecast(value: unknown): boolean {
  return value === "schedule-kit-v3" || value === "schedule-kit-v4" || value === "schedule-kit-v5";
}

export function isLegacyForecastRules(value: unknown): boolean {
  return value === "schedule-kit-v2";
}

export function isPublicationVersionPair(payload: unknown, rules: unknown): boolean {
  return isForecastVersionPair(payload, rules) && usesLedgerForecast(rules);
}

export function forecastVersionsForSnapshot(version: unknown) {
  if (version === "certified-daily-v3")
    return { payloadVersion: 4 as const, rulesVersion: "schedule-kit-v3" as const };
  if (version === "certified-daily-v4")
    return { payloadVersion: 5 as const, rulesVersion: "schedule-kit-v4" as const };
  if (version === "certified-daily-v5")
    return { payloadVersion: 6 as const, rulesVersion: "schedule-kit-v5" as const };
  throw new Error("unsupported_forecast_version");
}

export type CertifiedVersionPolicy = Readonly<{
  cohortCount: 3 | 4;
  physicalLaws: boolean;
  minimumWait: boolean;
  historyDays: 7 | 56;
  segmentsAndGrants: boolean;
  fixedDispatch: boolean;
}>;

const policies: Readonly<Record<CertifiedSnapshotVersion, CertifiedVersionPolicy>> = {
  "certified-daily-v1": policy(3, false, false, 56, false),
  "certified-daily-v2": policy(4, false, true, 56, false),
  "certified-daily-v3": policy(4, true, true, 7, false),
  "certified-daily-v4": policy(4, true, true, 7, true),
  "certified-daily-v5": policy(3, true, true, 7, true, true),
};

function policy(
  cohortCount: 3 | 4,
  physicalLaws: boolean,
  minimumWait: boolean,
  historyDays: 7 | 56,
  segmentsAndGrants: boolean,
  fixedDispatch = false,
): CertifiedVersionPolicy {
  return Object.freeze({
    cohortCount,
    physicalLaws,
    minimumWait,
    historyDays,
    segmentsAndGrants,
    fixedDispatch,
  });
}

export function isCertifiedSnapshotVersion(value: unknown): value is CertifiedSnapshotVersion {
  return typeof value === "string" && Object.hasOwn(policies, value);
}

export function certifiedVersionPolicy(value: unknown): CertifiedVersionPolicy {
  if (!isCertifiedSnapshotVersion(value))
    throw new Error("certified_snapshot_version_or_provenance_invalid");
  return policies[value];
}

/** Historical wire pairs stay admitted without rewriting signed payloads. */
export function isForecastVersionPair(payloadVersion: unknown, rulesVersion: unknown): boolean {
  return (
    (payloadVersion === 3 && rulesVersion === "schedule-kit-v2") ||
    (payloadVersion === 4 && rulesVersion === "schedule-kit-v3") ||
    (payloadVersion === 5 && rulesVersion === "schedule-kit-v4") ||
    (payloadVersion === 6 && rulesVersion === "schedule-kit-v5")
  );
}
