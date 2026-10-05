import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { isCertifiedSupplySnapshot } from "../shared/certifiedSupply.ts";

type EligibilityApproval = { forecastId: string; registrySha: string };
type EligibilityResult = { state: "valid" | "failed_permanent"; errorCode?: string };

export function validateStagingRegistry(
  approval: EligibilityApproval,
  value: unknown,
): EligibilityResult {
  const registry = parseRegistryContract(value);
  if (registry["approvedForecastId"] !== approval.forecastId)
    return { state: "failed_permanent", errorCode: "registry_approved_forecast_changed" };
  if (registry["activeForecastId"] === approval.forecastId)
    return { state: "failed_permanent", errorCode: "registry_forecast_already_active" };
  const forecast = registry.forecasts.find(
    (entry) => isRecord(entry) && entry["id"] === approval.forecastId,
  );
  if (
    !isRecord(forecast) ||
    forecast["kind"] !== "schedule" ||
    forecast["rulesVersion"] !== "schedule-kit-v2"
  )
    return { state: "failed_permanent", errorCode: "registry_forecast_ineligible" };
  if (
    forecast["certifiedSnapshot"] !== undefined &&
    !isCertifiedSupplySnapshot(forecast["certifiedSnapshot"])
  )
    return { state: "failed_permanent", errorCode: "registry_certified_snapshot_invalid" };
  return { state: "valid" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseRegistryContract(value: unknown): Record<string, unknown> & { forecasts: unknown[] } {
  if (!isRecord(value) || value["version"] !== 3 || !Array.isArray(value["forecasts"]))
    throw new Error("main_registry_contract_invalid");
  return { ...value, forecasts: value["forecasts"] };
}

export class StagingForecastEligibilityError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string) {
    super(
      errorCode === "registry_approved_forecast_changed"
        ? "Staging may select only the inactive approved forecast."
        : errorCode === "registry_forecast_already_active"
          ? "Forecast is already active in production; staging selection is unnecessary."
          : errorCode,
    );
    this.errorCode = errorCode;
    this.name = "StagingForecastEligibilityError";
  }
}

export async function recordSelectionDisposition(
  approvalId: string,
  error: StagingForecastEligibilityError,
  fetchImpl: typeof fetch = fetch,
) {
  const baseUrl = process.env["FORECAST_COLLECTOR_URL"],
    token = process.env["FORECAST_COLLECTOR_ADMIN_TOKEN"];
  if (!baseUrl || !token || !/^discord-staging-[a-f0-9-]{36}$/.test(approvalId))
    throw new Error("selection_disposition_configuration_invalid");
  const response = await fetchImpl(
    `${baseUrl.replace(/\/$/, "")}/admin/discord-staging-adoptions/${approvalId}/processing`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        state: "failed_permanent",
        errorCode: error.errorCode,
        ...(process.env["ADOPTION_LEASE_TOKEN"]
          ? { leaseToken: process.env["ADOPTION_LEASE_TOKEN"] }
          : {}),
      }),
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) throw new Error(`selection_disposition_http_${response.status}`);
  await response.body?.cancel();
}

export async function validateCurrentMainApproval(
  approval: EligibilityApproval,
  root = process.cwd(),
): Promise<EligibilityResult> {
  const registry: unknown = JSON.parse(
    readFileSync(resolve(root, "shared/supplyForecasts.json"), "utf8"),
  );
  const eligibility = validateStagingRegistry(approval, registry);
  if (eligibility.state !== "valid") return eligibility;
  try {
    await promisify(execFile)(
      "git",
      ["merge-base", "--is-ancestor", approval.registrySha, "HEAD"],
      { cwd: root, timeout: 10_000, maxBuffer: 16_384 },
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1)
      return { state: "failed_permanent", errorCode: "registry_sha_not_ancestor" };
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === 128 &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.trim() === `fatal: Not a valid commit name ${approval.registrySha}`
    )
      return { state: "failed_permanent", errorCode: "registry_sha_unavailable" };
    throw error;
  }
  return { state: "valid" };
}
