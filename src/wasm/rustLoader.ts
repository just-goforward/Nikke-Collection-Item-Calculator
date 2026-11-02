import { ignoreExpectedError } from "../lib/errorHandling";
import { LEGACY_WASM_ASSET } from "../../shared/generated/wasmRuntimeAssets";
import { fetchVerifiedWasmAsset, type WasmAssetPin } from "../../shared/wasmAssetBytes";
import { activeSupplyForecastContext } from "./rustCoreShared";
import { createRustMinEfSolver } from "./rustMinEfCore";
import { createRustPhase2Solver } from "./rustPhase2Core";
import type {
  RustCoreExports,
  RustMinEfSolver,
  RustPhase2ProductSolver,
  SupplyForecastContext,
} from "./rustTypes";

export function rustCoreExportsFromInstance(instance: WebAssembly.Instance): RustCoreExports {
  return instance.exports as unknown as RustCoreExports;
}

function createRustPhase2SolverFromInstance(
  instance: WebAssembly.Instance,
  supplyForecast: SupplyForecastContext,
): RustPhase2ProductSolver {
  return createRustPhase2Solver(rustCoreExportsFromInstance(instance), supplyForecast);
}

function createRustMinEfSolverFromInstance(
  instance: WebAssembly.Instance,
  supplyForecast: SupplyForecastContext,
): RustMinEfSolver {
  return createRustMinEfSolver(rustCoreExportsFromInstance(instance), supplyForecast);
}

export async function instantiateRustWasmFromUrl(
  url: string, asset?: WasmAssetPin,
): Promise<WebAssembly.Instance> {
  if (asset) {
    const bytes = await fetchVerifiedWasmAsset(url, asset, "rust_wasm");
    const { instance } = await WebAssembly.instantiate(new Uint8Array(bytes));
    return instance;
  }
  try {
    const { instance } = await WebAssembly.instantiateStreaming(fetch(url));
    return instance;
  } catch (error) {
    ignoreExpectedError(
      "WebAssembly.instantiateStreaming failed; retrying ArrayBuffer fallback",
      error,
    );
    const bytes = await (await fetch(url)).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes);
    return instance;
  }
}

export async function loadRustMinEfSolver(
  url: string,
  supplyForecast = activeSupplyForecastContext(),
): Promise<RustMinEfSolver> {
  const instance = await instantiateRustWasmFromUrl(url, LEGACY_WASM_ASSET);
  return createRustMinEfSolverFromInstance(instance, supplyForecast);
}

export async function loadRustPhase2Solver(
  url: string,
  supplyForecast = activeSupplyForecastContext(),
): Promise<RustPhase2ProductSolver> {
  const instance = await instantiateRustWasmFromUrl(url, LEGACY_WASM_ASSET);
  return createRustPhase2SolverFromInstance(instance, supplyForecast);
}
