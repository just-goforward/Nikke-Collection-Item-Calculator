import { loadRustPhase2ResearchSolver } from "./rustResearchLoader";
import type { RustPhase2ResearchSolver, SupplyForecastContext } from "./rustTypes";

let phase2ResearchSolverPromise: Promise<RustPhase2ResearchSolver> | null = null;

export async function getRustPhase2ResearchSolver(
  wasmUrl: string,
  supplyForecast?: SupplyForecastContext,
) {
  phase2ResearchSolverPromise ??= loadRustPhase2ResearchSolver(wasmUrl, supplyForecast);
  return phase2ResearchSolverPromise;
}
