import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CertifiedSupplySnapshot } from "../shared/certifiedSupply.ts";
import { registryCertifiedSnapshot } from "./certified-forecast-registry.ts";
import {
  recordSelectionDisposition,
  StagingForecastEligibilityError,
  validateStagingRegistry,
} from "./staging-adoption-eligibility.ts";

type Registry = {
  version: 3;
  activeForecastId: string;
  stagingForecastId: string;
  approvedForecastId: string;
  forecasts: Array<{
    id: string;
    kind: string;
    rulesVersion: string;
    certifiedSnapshot?: CertifiedSupplySnapshot;
  }>;
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
  const eligibility = validateStagingRegistry({ forecastId, registrySha: "" }, value);
  if (eligibility.state !== "valid")
    throw new StagingForecastEligibilityError(
      eligibility.errorCode ?? "registry_forecast_ineligible",
    );
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
  registryCertifiedSnapshot(forecast);
  return value as Registry;
}

async function main() {
  const forecastId = process.argv[2];
  if (!forecastId) throw new Error("Usage: select-staging-forecast <forecast-id>");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const registryPath = resolve(root, "shared", "supplyForecasts.json");
  let registry: Registry;
  try {
    registry = selectForecastForStagingRuntime(
      JSON.parse(await readFile(registryPath, "utf8")),
      forecastId,
    );
  } catch (error) {
    if (error instanceof StagingForecastEligibilityError && process.env["APPROVAL_ID"])
      await recordSelectionDisposition(process.env["APPROVAL_ID"], error);
    throw error;
  }
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  console.log(`Selected runtime staging forecast ${forecastId}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
