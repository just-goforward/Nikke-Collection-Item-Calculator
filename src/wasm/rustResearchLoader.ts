import { ignoreExpectedError } from "../lib/errorHandling";
import { rustCoreExportsFromInstance } from "./rustLoader";
import { createRustPhase2ResearchSolver } from "./rustPhase2ResearchCore";
import type { RustPhase2Solver } from "./rustTypes";

export function createRustPhase2ResearchSolverFromInstance(
  instance: WebAssembly.Instance,
): RustPhase2Solver {
  return createRustPhase2ResearchSolver(rustCoreExportsFromInstance(instance));
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

export async function loadRustPhase2ResearchSolver(url: string): Promise<RustPhase2Solver> {
  const instance = await instantiateWasmFromUrl(url);
  return createRustPhase2ResearchSolverFromInstance(instance);
}
