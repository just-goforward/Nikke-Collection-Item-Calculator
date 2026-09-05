import { instantiateRustWasmFromUrl, rustCoreExportsFromInstance } from "./rustLoader";
import { createRustPhase2ResearchSolver } from "./rustPhase2ResearchCore";
import type { RustPhase2ResearchSolver } from "./rustTypes";

export function createRustPhase2ResearchSolverFromInstance(
  instance: WebAssembly.Instance,
): RustPhase2ResearchSolver {
  return createRustPhase2ResearchSolver(rustCoreExportsFromInstance(instance));
}

export async function loadRustPhase2ResearchSolver(url: string): Promise<RustPhase2ResearchSolver> {
  const instance = await instantiateRustWasmFromUrl(url);
  return createRustPhase2ResearchSolverFromInstance(instance);
}
