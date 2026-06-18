import { loadRustPhase2ResearchSolver } from "./rustResearchLoader";
import type { RustPhase2Solver } from "./rustTypes";

let phase2ResearchSolverPromise: Promise<RustPhase2Solver> | null = null;

export async function getRustPhase2ResearchSolver(wasmUrl: string) {
  phase2ResearchSolverPromise ??= loadRustPhase2ResearchSolver(wasmUrl);
  return phase2ResearchSolverPromise;
}
