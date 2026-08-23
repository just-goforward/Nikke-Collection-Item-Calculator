import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Gain = { blue: number; purple: number; yellow: number };
type Forecast = {
  id: string;
  basisDays: number;
  effectiveFrom: string;
  expectedGain: Gain;
};
type Registry = {
  version: number;
  activeForecastId: string;
  forecasts: Forecast[];
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "shared", "supplyForecasts.json");
const tsPath = resolve(root, "shared", "generated", "supplyForecast.ts");
const rustPath = resolve(root, "rust", "solver-rs", "src", "generated_supply_forecast.rs");
const checkOnly = process.argv.includes("--check");

const registry = validateRegistry(JSON.parse(await readFile(sourcePath, "utf8")));
const activeIndex = registry.forecasts.findIndex(
  (forecast) => forecast.id === registry.activeForecastId,
);
if (activeIndex < 0) {
  throw new Error(`Active supply forecast is missing: ${registry.activeForecastId}`);
}
const active = registry.forecasts[activeIndex];
if (!active) throw new Error("Active supply forecast index is invalid.");

const expected = new Map<string, string>([
  [tsPath, renderTypeScript(registry, activeIndex)],
  [rustPath, renderRust(active)],
]);

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
  if (!isRecord(value) || value["version"] !== 1) {
    throw new Error("Supply forecast registry must use version 1.");
  }
  const activeForecastId = value["activeForecastId"];
  const rawForecasts = value["forecasts"];
  if (typeof activeForecastId !== "string" || !Array.isArray(rawForecasts)) {
    throw new Error("Supply forecast registry is missing its active ID or forecast list.");
  }
  const ids = new Set<string>();
  const forecasts = rawForecasts.map((raw) => validateForecast(raw, ids));
  if (forecasts.length === 0) throw new Error("Supply forecast registry must not be empty.");
  return { version: 1, activeForecastId, forecasts };
}

function validateForecast(value: unknown, ids: Set<string>): Forecast {
  if (!isRecord(value)) throw new Error("Supply forecast entry must be an object.");
  const id = value["id"];
  const basisDays = value["basisDays"];
  const effectiveFrom = value["effectiveFrom"];
  const expectedGain = value["expectedGain"];
  if (typeof id !== "string" || !/^supply-\d{4}-\d{2}-\d{2}-v\d+$/.test(id)) {
    throw new Error(`Invalid supply forecast ID: ${String(id)}`);
  }
  if (ids.has(id)) throw new Error(`Duplicate supply forecast ID: ${id}`);
  ids.add(id);
  if (basisDays !== 28) throw new Error(`${id} must use a 28-day basis.`);
  if (typeof effectiveFrom !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    throw new Error(`${id} has an invalid effective date.`);
  }
  if (!isRecord(expectedGain)) throw new Error(`${id} is missing expected gains.`);
  const gain = {
    blue: positiveFinite(expectedGain["blue"], `${id}.blue`),
    purple: positiveFinite(expectedGain["purple"], `${id}.purple`),
    yellow: positiveFinite(expectedGain["yellow"], `${id}.yellow`),
  };
  return { id, basisDays, effectiveFrom, expectedGain: gain };
}

function positiveFinite(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderTypeScript(registry: Registry, activeIndex: number) {
  const forecasts = registry.forecasts
    .map(
      (forecast) =>
        `    {\n` +
        `      id: ${JSON.stringify(forecast.id)},\n` +
        `      basisDays: ${forecast.basisDays},\n` +
        `      effectiveFrom: ${JSON.stringify(forecast.effectiveFrom)},\n` +
        `      expectedGain: {\n` +
        `        blue: ${forecast.expectedGain.blue},\n` +
        `        purple: ${forecast.expectedGain.purple},\n` +
        `        yellow: ${forecast.expectedGain.yellow},\n` +
        `      },\n` +
        `    },`,
    )
    .join("\n");
  return (
    `// Generated from shared/supplyForecasts.json. Do not edit directly.\n` +
    `export const SUPPLY_FORECAST_REGISTRY = {\n` +
    `  version: ${registry.version},\n` +
    `  activeForecastId: ${JSON.stringify(registry.activeForecastId)},\n` +
    `  forecasts: [\n${forecasts}\n  ],\n` +
    `} as const;\n\n` +
    `export const ACTIVE_SUPPLY_FORECAST_ID = SUPPLY_FORECAST_REGISTRY.activeForecastId;\n` +
    `export const ACTIVE_SUPPLY_FORECAST = SUPPLY_FORECAST_REGISTRY.forecasts[${activeIndex}];\n\n` +
    `export type SupplyForecastId = (typeof SUPPLY_FORECAST_REGISTRY.forecasts)[number]["id"];\n\n` +
    `export function isSupplyForecastId(value: unknown): value is SupplyForecastId {\n` +
    `  return (SUPPLY_FORECAST_REGISTRY.forecasts as readonly { id: string }[]).some(\n` +
    `    (forecast) => forecast.id === value,\n` +
    `  );\n` +
    `}\n`
  );
}

function renderRust(forecast: Forecast) {
  const gain = forecast.expectedGain;
  return (
    `// Generated from shared/supplyForecasts.json (${forecast.id}). Do not edit directly.\n` +
    `pub(crate) const GAIN_B: f64 = ${rustFloat(gain.blue)};\n` +
    `pub(crate) const GAIN_P: f64 = ${rustFloat(gain.purple)};\n` +
    `pub(crate) const GAIN_Y: f64 = ${rustFloat(gain.yellow)};\n`
  );
}

function rustFloat(value: number) {
  const rendered = String(value);
  return rendered.includes(".") ? rendered : `${rendered}.0`;
}
