import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Registry = {
  version: 3;
  activeForecastId: string;
  stagingForecastId: string;
  approvedForecastId: string;
  forecasts: Array<{ id: string; kind: string; rulesVersion: string }>;
};

export function activateForecastForStaging(value: unknown, forecastId: string): Registry {
  const registry = validatedStagingRegistry(value, forecastId);
  if (registry.activeForecastId === forecastId) {
    throw new Error("Forecast is already active in production; staging override is unnecessary.");
  }
  return { ...registry, activeForecastId: forecastId };
}

export function selectForecastForStagingRuntime(value: unknown, forecastId: string): Registry {
  const registry = validatedStagingRegistry(value, forecastId);
  return { ...registry, stagingForecastId: forecastId };
}

function validatedStagingRegistry(value: unknown, forecastId: string): Registry {
  if (
    !isRecord(value) ||
    value["version"] !== 3 ||
    typeof value["activeForecastId"] !== "string" ||
    typeof value["stagingForecastId"] !== "string" ||
    typeof value["approvedForecastId"] !== "string" ||
    !Array.isArray(value["forecasts"])
  ) {
    throw new Error("Supply forecast registry is invalid.");
  }
  if (!/^supply-\d{4}-\d{2}-\d{2}-v\d+$/.test(forecastId)) {
    throw new Error("Staging forecast ID is invalid.");
  }
  if (value["approvedForecastId"] !== forecastId) {
    throw new Error("Staging may activate only the inactive approved forecast.");
  }
  const forecast = value["forecasts"].find(
    (entry) => isRecord(entry) && entry["id"] === forecastId,
  );
  if (
    !isRecord(forecast) ||
    forecast["kind"] !== "schedule" ||
    forecast["rulesVersion"] !== "schedule-kit-v2"
  ) {
    throw new Error("Staging forecast does not satisfy the schedule-kit-v2 contract.");
  }
  return value as Registry;
}

async function main() {
  const pointerOnly = process.argv.includes("--pointer");
  const forecastId = process.argv.slice(2).find((argument) => argument !== "--pointer");
  if (!forecastId) {
    throw new Error("Usage: prepare-staging-forecast [--pointer] <forecast-id>");
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const registryPath = resolve(root, "shared", "supplyForecasts.json");
  const source = JSON.parse(await readFile(registryPath, "utf8"));
  const registry = pointerOnly
    ? selectForecastForStagingRuntime(source, forecastId)
    : activateForecastForStaging(source, forecastId);
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  console.log(
    pointerOnly
      ? `Selected runtime staging forecast ${forecastId}.`
      : `Prepared staging-only active forecast ${forecastId}.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
