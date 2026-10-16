import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "vite";
import staging from "../site-worker/forecast-runtime.json" with { type: "json" };

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
  mode: "bundled" | "staging";
  keyId: string;
  publicKeyBase64: string;
};
const METADATA = ".vite/forecast-runtime.json";

/** Record Vite's resolved env, including env files, not a guess from process.env.
 * Production receipts already hash all .vite metadata and exclude it from upload.
 */
export function forecastRuntimeBuildPlugin(): Plugin {
  let metadata: ForecastBuild;
  return {
    name: "forecast-runtime-build-identity",
    apply: "build",
    configResolved(config) {
      const enabled = config.env["VITE_FORECAST_RUNTIME"] === "staging";
      metadata = {
        version: 1,
        mode: enabled ? "staging" : "bundled",
        keyId: enabled ? String(config.env["VITE_FORECAST_PUBLIC_KEY_ID"] ?? "") : "",
        publicKeyBase64: enabled ? String(config.env["VITE_FORECAST_PUBLIC_KEY_BASE64"] ?? "") : "",
      };
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: METADATA, source: JSON.stringify(metadata) });
    },
  };
}

export async function assertForecastBuild(directory: string, mode: ForecastBuild["mode"]) {
  const metadata: ForecastBuild = JSON.parse(await readFile(join(directory, METADATA), "utf8"));
  const key = mode === "staging" ? staging : { keyId: "", publicKeyBase64: "" };
  if (
    metadata.version !== 1 ||
    metadata.mode !== mode ||
    metadata.keyId !== key.keyId ||
    metadata.publicKeyBase64 !== key.publicKeyBase64
  )
    throw new Error(
      `Invalid ${mode} runtime forecast build; rebuild with the matching site command.`,
    );
}
