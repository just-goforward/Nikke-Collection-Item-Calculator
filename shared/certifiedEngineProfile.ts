import { CERTIFIED_ENGINE_CODE_HASH } from "./generated/certifiedEngineBuild";
import { CERTIFIED_WASM_HASH } from "./generated/certifiedWasmBuild";

/** A single, serialized contract identifies every part of the staging engine. */
export type CertifiedEngineProfile = {
  id: "certified-staging-v2";
  environment: "staging";
  schemaVersion: "certified-daily-v2";
  priceVersion: "stock-plus-recurring-day-v1";
  solverVersion: "certified-exact-rust-wasm-v1";
  lawVersion: "documented-physical-supply-v2";
  wasmHash: string;
  codeHash: string;
  cacheNamespace: string;
  sessionNamespace: "collection-certified-staging-v2";
  diagnosticsEnvironment: "staging";
  recoveryEnvironment: "staging";
};

export const CERTIFIED_STAGING_ENGINE_PROFILE: Readonly<CertifiedEngineProfile> = Object.freeze({
  id: "certified-staging-v2",
  environment: "staging",
  schemaVersion: "certified-daily-v2",
  priceVersion: "stock-plus-recurring-day-v1",
  solverVersion: "certified-exact-rust-wasm-v1",
  lawVersion: "documented-physical-supply-v2",
  wasmHash: CERTIFIED_WASM_HASH,
  codeHash: CERTIFIED_ENGINE_CODE_HASH,
  cacheNamespace: `certified-staging-v2:${CERTIFIED_ENGINE_CODE_HASH}`,
  sessionNamespace: "collection-certified-staging-v2",
  diagnosticsEnvironment: "staging",
  recoveryEnvironment: "staging",
});

export function assertCertifiedEngineProfile(value: unknown): CertifiedEngineProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("certified_engine_profile_mismatch");
  }
  for (const [key, expected] of Object.entries(CERTIFIED_STAGING_ENGINE_PROFILE)) {
    if (Reflect.get(value, key) !== expected) {
      throw new TypeError("certified_engine_profile_mismatch");
    }
  }
  if (Object.keys(value).length !== Object.keys(CERTIFIED_STAGING_ENGINE_PROFILE).length) {
    throw new TypeError("certified_engine_profile_mismatch");
  }
  return { ...CERTIFIED_STAGING_ENGINE_PROFILE };
}
