import { ignoreExpectedError } from "../lib/errorHandling";
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

export async function instantiateRustWasmFromUrl(url: string): Promise<WebAssembly.Instance> {
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
  const instance = await instantiateRustWasmFromUrl(url);
  return createRustMinEfSolverFromInstance(instance, supplyForecast);
}

export async function loadRustPhase2Solver(
  url: string,
  supplyForecast = activeSupplyForecastContext(),
): Promise<RustPhase2ProductSolver> {
  const instance = await instantiateRustWasmFromUrl(url);
  return createRustPhase2SolverFromInstance(instance, supplyForecast);
}
