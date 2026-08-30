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
    throw new Error("Staging may select only the inactive approved forecast.");
  }
  if (value["activeForecastId"] === forecastId) {
    throw new Error("Forecast is already active in production; staging selection is unnecessary.");
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
  const forecastId = process.argv[2];
  if (!forecastId) throw new Error("Usage: select-staging-forecast <forecast-id>");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const registryPath = resolve(root, "shared", "supplyForecasts.json");
  const registry = selectForecastForStagingRuntime(
    JSON.parse(await readFile(registryPath, "utf8")),
    forecastId,
  );
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  console.log(`Selected runtime staging forecast ${forecastId}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
