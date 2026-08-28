import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Gain = { blue: number; purple: number; yellow: number };
type Profile = {
  id: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  scheduleStatus: "confirmed" | "estimated";
  expectedGain: Gain;
};
type Forecast = {
  id: string;
  kind: "fixed" | "schedule";
  rulesVersion: string;
  effectiveFrom: string;
  sourceEvidence: unknown[];
  profiles: Profile[];
};
type Registry = {
  version: 2;
  activeForecastId: string;
  approvedForecastId: string;
  forecasts: Forecast[];
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "shared", "supplyForecasts.json");
const tsPath = resolve(root, "shared", "generated", "supplyForecast.ts");
const checkOnly = process.argv.includes("--check");

const registry = validateRegistry(JSON.parse(await readFile(sourcePath, "utf8")));
const activeIndex = registry.forecasts.findIndex(
  (forecast) => forecast.id === registry.activeForecastId,
);
if (activeIndex < 0)
  throw new Error(`Active supply forecast is missing: ${registry.activeForecastId}`);
if (!registry.forecasts.some((forecast) => forecast.id === registry.approvedForecastId)) {
  throw new Error(`Approved supply forecast is missing: ${registry.approvedForecastId}`);
}
const active = registry.forecasts[activeIndex];
if (!active) throw new Error("Active supply forecast index is invalid.");
const expected = new Map<string, string>([[tsPath, renderTypeScript(registry, active)]]);

let stale = false;
for (const [path, content] of expected) {
  if (checkOnly) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== content) {
      console.error(`Generated supply forecast is out of date: ${path}`);
      stale = true;
    }
    continue;
  }
  await writeFile(path, content, "utf8");
  console.log(`Generated ${path}`);
}

if (stale) process.exit(1);

function validateRegistry(value: unknown): Registry {
  if (!isRecord(value) || value["version"] !== 2) {
    throw new Error("Supply forecast registry must use version 2.");
  }
  const activeForecastId = value["activeForecastId"];
  const approvedForecastId = value["approvedForecastId"];
  const rawForecasts = value["forecasts"];
  if (
    typeof activeForecastId !== "string" ||
    typeof approvedForecastId !== "string" ||
    !Array.isArray(rawForecasts)
  ) {
    throw new Error("Supply forecast registry is missing its active/approved ID or forecast list.");
  }
  const ids = new Set<string>();
  const profileIds = new Set<string>();
  const forecasts = rawForecasts.map((raw) => validateForecast(raw, ids, profileIds));
  if (forecasts.length === 0) throw new Error("Supply forecast registry must not be empty.");
  return { version: 2, activeForecastId, approvedForecastId, forecasts };
}

function validateForecast(value: unknown, ids: Set<string>, profileIds: Set<string>): Forecast {
  if (!isRecord(value)) throw new Error("Supply forecast entry must be an object.");
  const id = value["id"];
  const kind = value["kind"];
  const rulesVersion = value["rulesVersion"];
  const effectiveFrom = value["effectiveFrom"];
  const sourceEvidence = value["sourceEvidence"];
  const rawProfiles = value["profiles"];
  if (typeof id !== "string" || !/^supply-\d{4}-\d{2}-\d{2}-v\d+$/.test(id)) {
    throw new Error(`Invalid supply forecast ID: ${String(id)}`);
  }
  if (ids.has(id)) throw new Error(`Duplicate supply forecast ID: ${id}`);
  ids.add(id);
  if (kind !== "fixed" && kind !== "schedule") throw new Error(`${id} has an invalid kind.`);
  if (typeof rulesVersion !== "string" || !/^[a-z0-9-]+-v\d+$/.test(rulesVersion)) {
    throw new Error(`${id} has an invalid rules version.`);
  }
  if (typeof effectiveFrom !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    throw new Error(`${id} has an invalid effective date.`);
  }
  if (!Array.isArray(sourceEvidence)) throw new Error(`${id} has invalid source evidence.`);
  if (!Array.isArray(rawProfiles) || rawProfiles.length === 0) {
    throw new Error(`${id} must contain at least one profile.`);
  }
  const profiles = rawProfiles.map((raw) => validateProfile(raw, id, profileIds));
  validateProfileSequence(id, profiles);
  return { id, kind, rulesVersion, effectiveFrom, sourceEvidence, profiles };
}

function validateProfile(value: unknown, forecastId: string, ids: Set<string>): Profile {
  if (!isRecord(value)) throw new Error(`${forecastId} profile must be an object.`);
  const id = value["id"];
  const effectiveFrom = value["effectiveFrom"];
  const effectiveUntil = value["effectiveUntil"];
  const scheduleStatus = value["scheduleStatus"];
  const expectedGain = value["expectedGain"];
  if (typeof id !== "string" || !id.startsWith(`${forecastId}@`)) {
    throw new Error(`${forecastId} has an invalid profile ID: ${String(id)}`);
  }
  if (ids.has(id)) throw new Error(`Duplicate supply forecast profile ID: ${id}`);
  ids.add(id);
  const from = timestamp(effectiveFrom, `${id}.effectiveFrom`);
  const until = effectiveUntil === null ? null : timestamp(effectiveUntil, `${id}.effectiveUntil`);
  if (until !== null && until <= from) throw new Error(`${id} has an inverted interval.`);
  if (scheduleStatus !== "confirmed" && scheduleStatus !== "estimated") {
    throw new Error(`${id} has an invalid schedule status.`);
  }
  if (!isRecord(expectedGain)) throw new Error(`${id} is missing expected gains.`);
  const gain = {
    blue: nonNegativeFinite(expectedGain["blue"], `${id}.blue`),
    purple: nonNegativeFinite(expectedGain["purple"], `${id}.purple`),
    yellow: nonNegativeFinite(expectedGain["yellow"], `${id}.yellow`),
  };
  return {
    id,
    effectiveFrom: new Date(from).toISOString(),
    effectiveUntil: until === null ? null : new Date(until).toISOString(),
    scheduleStatus,
    expectedGain: gain,
  };
}

function validateProfileSequence(forecastId: string, profiles: readonly Profile[]) {
  for (let index = 0; index < profiles.length; index += 1) {
    const current = profiles[index];
    if (!current) continue;
    const next = profiles[index + 1];
    if (next && current.effectiveUntil !== next.effectiveFrom) {
      throw new Error(`${forecastId} profiles must be contiguous and ordered.`);
    }
    if (!next && current.effectiveUntil !== null) {
      throw new Error(`${forecastId} final profile must be open-ended.`);
    }
  }
}

function timestamp(value: unknown, label: string) {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${label} must be an offset timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid.`);
  return parsed;
}

function nonNegativeFinite(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderTypeScript(registry: Registry, active: Forecast) {
  const serialized = JSON.stringify(registry, null, 2)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  const serializedActive = JSON.stringify(active, null, 2)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return (
    `// Generated from shared/supplyForecasts.json. Do not edit directly.\n` +
    `export const ACTIVE_SUPPLY_FORECAST_ID = ${JSON.stringify(active.id)} as const;\n` +
    `export const ACTIVE_SUPPLY_FORECAST =\n${serializedActive} as const;\n\n` +
    `export const ACTIVE_SUPPLY_FORECAST_BASE_PROFILE = ACTIVE_SUPPLY_FORECAST.profiles[0];\n` +
    `export const ACTIVE_SUPPLY_FORECAST_BASE_PROFILE_ID = ACTIVE_SUPPLY_FORECAST_BASE_PROFILE.id;\n\n` +
    `export const SUPPLY_FORECAST_REGISTRY =\n${serialized} as const;\n\n` +
    `export type SupplyForecastId = (typeof SUPPLY_FORECAST_REGISTRY.forecasts)[number]["id"];\n` +
    `export type SupplyForecastProfile = {\n` +
    `  id: string;\n` +
    `  effectiveFrom: string;\n` +
    `  effectiveUntil: string | null;\n` +
    `  scheduleStatus: "confirmed" | "estimated";\n` +
    `  expectedGain: { blue: number; purple: number; yellow: number };\n` +
    `};\n\n` +
    `export function isSupplyForecastId(value: unknown): value is SupplyForecastId {\n` +
    `  return (SUPPLY_FORECAST_REGISTRY.forecasts as readonly { id: string }[]).some(\n` +
    `    (forecast) => forecast.id === value,\n` +
    `  );\n` +
    `}\n\n` +
    `export function isSupplyForecastProfileId(value: unknown): value is string {\n` +
    `  return SUPPLY_FORECAST_REGISTRY.forecasts.some((forecast) =>\n` +
    `    forecast.profiles.some((profile) => profile.id === value),\n` +
    `  );\n` +
    `}\n\n` +
    `export function resolveSupplyForecastProfile(\n` +
    `  forecastId: string,\n` +
    `  timestampMs = Date.now(),\n` +
    `): SupplyForecastProfile | null {\n` +
    `  const forecast = SUPPLY_FORECAST_REGISTRY.forecasts.find((entry) => entry.id === forecastId);\n` +
    `  if (!forecast) return null;\n` +
    `  return (forecast.profiles as readonly SupplyForecastProfile[]).find((profile) => {\n` +
    `    const from = Date.parse(profile.effectiveFrom);\n` +
    `    const until = profile.effectiveUntil === null ? Number.POSITIVE_INFINITY : Date.parse(profile.effectiveUntil);\n` +
    `    return timestampMs >= from && timestampMs < until;\n` +
    `  }) ?? null;\n` +
    `}\n\n` +
    `export function resolveActiveSupplyForecastProfile(\n` +
    `  timestampMs = Date.now(),\n` +
    `): SupplyForecastProfile {\n` +
    `  const profile = (ACTIVE_SUPPLY_FORECAST.profiles as readonly SupplyForecastProfile[]).find((entry) => {\n` +
    `    const from = Date.parse(entry.effectiveFrom);\n` +
    `    const until = entry.effectiveUntil === null ? Number.POSITIVE_INFINITY : Date.parse(entry.effectiveUntil);\n` +
    `    return timestampMs >= from && timestampMs < until;\n` +
    `  }) ?? null;\n` +
    `  if (!profile) throw new Error("The active supply forecast has no profile for the requested time.");\n` +
    `  return profile;\n` +
    `}\n`
  );
}
