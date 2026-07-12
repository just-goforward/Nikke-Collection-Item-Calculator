import { ignoreExpectedError } from "../lib/errorHandling";
import { createRustMinEfSolver } from "./rustMinEfCore";
import { createRustPhase2Solver } from "./rustPhase2Core";
import type { RustCoreExports, RustMinEfSolver, RustPhase2ProductSolver } from "./rustTypes";

export function rustCoreExportsFromInstance(instance: WebAssembly.Instance): RustCoreExports {
  return instance.exports as unknown as RustCoreExports;
}

function createRustPhase2SolverFromInstance(
  instance: WebAssembly.Instance,
): RustPhase2ProductSolver {
  return createRustPhase2Solver(rustCoreExportsFromInstance(instance));
}

function createRustMinEfSolverFromInstance(instance: WebAssembly.Instance): RustMinEfSolver {
  return createRustMinEfSolver(rustCoreExportsFromInstance(instance));
}

async function instantiateWasmFromUrl(url: string): Promise<WebAssembly.Instance> {
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

export async function loadRustMinEfSolver(url: string): Promise<RustMinEfSolver> {
  const instance = await instantiateWasmFromUrl(url);
  return createRustMinEfSolverFromInstance(instance);
}

export async function loadRustPhase2Solver(url: string): Promise<RustPhase2ProductSolver> {
  const instance = await instantiateWasmFromUrl(url);
  return createRustPhase2SolverFromInstance(instance);
}
