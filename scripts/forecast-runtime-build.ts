import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "vite";
import { assertCertifiedEngineProfile, type CertifiedEngineProfile } from "../shared/certifiedEngineProfile.ts";
import { runtimeForecastEnvironment } from "../shared/runtimeForecastMode.ts";
import staging from "../site-worker/forecast-runtime.json" with { type: "json" };
import productionProposal from "../site-worker/production-forecast.proposed.json" with { type: "json" };

import timedProposal from "../site-worker/production-forecast-timed-v1.proposed.json" with { type: "json" };

type TimedTrust = { keyId: string; publicKeyBase64: string };
/** Operator-provisioned raw Ed25519 public bytes only. Never substitute a fixture,
 * ambient VITE_* value, or the signed legacy channel's verification key. */
export function productionTimedTrust(legacy: ProductionForecastContract): TimedTrust {
  const { keyId, publicKeyBase64 } = timedProposal as {keyId: string; publicKeyBase64: unknown};
  if (Object.keys(timedProposal).sort().join(",") !== "keyId,publicKeyBase64" ||
      keyId !== "production-timed-v1" || keyId === legacy.keyId || typeof publicKeyBase64 !== "string" ||
      !/^[A-Za-z0-9+/]{43}=$/.test(publicKeyBase64) ||
      Buffer.from(publicKeyBase64, "base64").toString("base64") !== publicKeyBase64 ||
      publicKeyBase64 === legacy.publicKeyBase64 || publicKeyBase64 === productionProposal.publicKeyBase64)
    throw new Error("production_timed_v1_public_trust_missing_or_invalid");
  return { keyId, publicKeyBase64 };
}

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
 * The checked-in contract records approved public trust, not deployment authority.
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

/** Build preparation only; this does not activate a deployed service. */
export function productionForecastBuildEnv(
  base: NodeJS.ProcessEnv, contract: unknown = productionProposal,
): NodeJS.ProcessEnv {
  const approved = assertProductionForecastContract(contract);
  const timed = productionTimedTrust(approved);
  return {
    ...base,
    VITE_FORECAST_RUNTIME: approved.environment,
    VITE_FORECAST_PUBLIC_KEY_ID: approved.keyId,
    VITE_FORECAST_PUBLIC_KEY_BASE64: approved.publicKeyBase64,
    VITE_FORECAST_TIMED_V1_PUBLIC_KEY_ID: timed.keyId,
    VITE_FORECAST_TIMED_V1_PUBLIC_KEY_BASE64: timed.publicKeyBase64,
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
  timedV1?: TimedTrust;
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
    // Validate production trust for dev servers as well as emitted builds.
    configResolved(config) {
      const environment = runtimeForecastEnvironment(config.env["VITE_FORECAST_RUNTIME"]);
      const enabled = environment !== null;
      const approved = environment === "production"
        ? assertProductionForecastContract(productionContract) : null;
      const timed = enabled ? {
        keyId: String(config.env["VITE_FORECAST_TIMED_V1_PUBLIC_KEY_ID"] ?? ""),
        publicKeyBase64: String(config.env["VITE_FORECAST_TIMED_V1_PUBLIC_KEY_BASE64"] ?? ""),
      } : undefined;
      const expected = approved && productionTimedTrust(approved);
      if (expected && (expected.keyId !== timed?.keyId || expected.publicKeyBase64 !== timed.publicKeyBase64))
        throw new Error("production_timed_v1_build_trust_mismatch");
      if (approved && (
        config.env["VITE_FORECAST_PUBLIC_KEY_ID"] !== approved.keyId ||
        config.env["VITE_FORECAST_PUBLIC_KEY_BASE64"] !== approved.publicKeyBase64
      )) throw new Error("production_forecast_build_trust_mismatch");
      metadata = {
        version: 1, ...(timed ? { timedV1: timed } : {}),
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
    const expected = productionTimedTrust(approved);
    if (metadata.timedV1?.keyId !== expected.keyId || metadata.timedV1.publicKeyBase64 !== expected.publicKeyBase64)
      throw new Error("production_timed_v1_build_trust_mismatch");
    assertCertifiedEngineProfile(metadata.engineProfile);
    if (metadata.approvalRef !== approved.approvalRef)
      throw new Error("production_forecast_build_approval_mismatch");
  }
}
