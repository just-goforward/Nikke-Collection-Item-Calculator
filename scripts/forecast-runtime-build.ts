import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "vite";
import { assertCertifiedEngineProfile, type CertifiedEngineProfile } from "../shared/certifiedEngineProfile.ts";
import { runtimeForecastEnvironment } from "../shared/runtimeForecastMode.ts";
import staging from "../site-worker/forecast-runtime.json" with { type: "json" };
import productionProposal from "../site-worker/production-forecast.proposed.json" with { type: "json" };

export type ProductionForecastContract = {
  version: 1;
  environment: "production";
  approvalRef: string;
  keyId: string;
  publicKeyBase64: string;
  engineProfile: CertifiedEngineProfile;
};

/** A local approval reference records an operator decision; it does not grant deployment
 * authority. Publication environment is separate from the exact engine contract, whose
 * staging-labelled fields also bind results, sessions and caches and must not be renamed.
 * The checked-in proposal deliberately lacks approval and production public trust.
 */
export function assertProductionForecastContract(value: unknown): ProductionForecastContract {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("production_forecast_contract_unapproved");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "approvalRef,engineProfile,environment,keyId,publicKeyBase64,version" ||
    record["version"] !== 1 ||
    record["environment"] !== "production" ||
    typeof record["approvalRef"] !== "string" || !record["approvalRef"].trim() ||
    typeof record["keyId"] !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(record["keyId"]) ||
    typeof record["publicKeyBase64"] !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(record["publicKeyBase64"])
  ) throw new Error("production_forecast_contract_unapproved: operator-reviewed approvalRef, keyId and Ed25519 public key required in site-worker/production-forecast.proposed.json; online build disabled");
  if (Buffer.from(record["publicKeyBase64"], "base64").toString("base64") !== record["publicKeyBase64"])
    throw new Error("production_forecast_public_key_noncanonical");
  const engineProfile = assertCertifiedEngineProfile(record["engineProfile"]);
  return {
    version: 1, environment: "production", approvalRef: record["approvalRef"],
    keyId: record["keyId"], publicKeyBase64: record["publicKeyBase64"], engineProfile,
  };
}

/** Explicit future build preparation only; no command, deployment or default activation. */
export function productionForecastBuildEnv(
  base: NodeJS.ProcessEnv, contract: unknown = productionProposal,
): NodeJS.ProcessEnv {
  const approved = assertProductionForecastContract(contract);
  return {
    ...base,
    VITE_FORECAST_RUNTIME: approved.environment,
    VITE_FORECAST_PUBLIC_KEY_ID: approved.keyId,
    VITE_FORECAST_PUBLIC_KEY_BASE64: approved.publicKeyBase64,
  };
}

export function stagingForecastBuildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    VITE_FORECAST_RUNTIME: staging.environment,
    VITE_FORECAST_PUBLIC_KEY_ID: staging.keyId,
    VITE_FORECAST_PUBLIC_KEY_BASE64: staging.publicKeyBase64,
  };
}

type ForecastBuild = {
  version: 1;
  mode: "bundled" | "staging" | "production";
  keyId: string;
  publicKeyBase64: string;
  engineProfile?: CertifiedEngineProfile;
  approvalRef?: string;
};
const METADATA = ".vite/forecast-runtime.json";

/** Record Vite's resolved env, including env files, not a guess from process.env.
 * Production receipts already hash all .vite metadata and exclude it from upload.
 */
export function forecastRuntimeBuildPlugin(productionContract: unknown = productionProposal): Plugin {
  let metadata: ForecastBuild;
  return {
    name: "forecast-runtime-build-identity",
    apply: "build",
    configResolved(config) {
      const environment = runtimeForecastEnvironment(config.env["VITE_FORECAST_RUNTIME"]);
      const enabled = environment !== null;
      const approved = environment === "production"
        ? assertProductionForecastContract(productionContract) : null;
      if (approved && (
        config.env["VITE_FORECAST_PUBLIC_KEY_ID"] !== approved.keyId ||
        config.env["VITE_FORECAST_PUBLIC_KEY_BASE64"] !== approved.publicKeyBase64
      )) throw new Error("production_forecast_build_trust_mismatch");
      metadata = {
        version: 1,
        mode: environment ?? "bundled",
        keyId: enabled ? String(config.env["VITE_FORECAST_PUBLIC_KEY_ID"] ?? "") : "",
        publicKeyBase64: enabled ? String(config.env["VITE_FORECAST_PUBLIC_KEY_BASE64"] ?? "") : "",
        ...(approved ? { engineProfile: approved.engineProfile, approvalRef: approved.approvalRef } : {}),
      };
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: METADATA, source: JSON.stringify(metadata) });
    },
  };
}

export async function assertForecastBuild(
  directory: string,
  mode: ForecastBuild["mode"],
  productionContract?: unknown,
) {
  const approved = mode === "production"
    ? assertProductionForecastContract(productionContract ?? productionProposal) : null;
  const metadata: ForecastBuild = JSON.parse(await readFile(join(directory, METADATA), "utf8"));
  const key = mode === "staging" ? staging :
    approved ?? { keyId: "", publicKeyBase64: "" };
  if (
    metadata.version !== 1 ||
    metadata.mode !== mode ||
    metadata.keyId !== key.keyId ||
    metadata.publicKeyBase64 !== key.publicKeyBase64
  )
    throw new Error(
      `Invalid ${mode} runtime forecast build; rebuild with the matching site command.`,
    );
  if (approved) {
    assertCertifiedEngineProfile(metadata.engineProfile);
    if (metadata.approvalRef !== approved.approvalRef)
      throw new Error("production_forecast_build_approval_mismatch");
  }
}
