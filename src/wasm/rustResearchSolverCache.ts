import { loadRustPhase2ResearchSolver } from "./rustResearchLoader";
import type { RustPhase2ResearchSolver } from "./rustTypes";

let phase2ResearchSolverPromise: Promise<RustPhase2ResearchSolver> | null = null;

export async function getRustPhase2ResearchSolver(wasmUrl: string) {
  phase2ResearchSolverPromise ??= loadRustPhase2ResearchSolver(wasmUrl);
  return phase2ResearchSolverPromise;
}
