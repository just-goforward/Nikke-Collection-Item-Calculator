import type { ProgressEvent, SolverInput } from "../types";
import type { MonteCarloResult, SolverResult } from "./calculatorShared";

export async function solveWithJsFallback(
  input: SolverInput,
  onProgress: (progress: ProgressEvent) => void,
): Promise<SolverResult> {
  const { solve } = await import("../solver/solve");
  return solve(input, onProgress) as SolverResult;
}

export async function validateWithJsFallback(
  input: SolverInput,
  runs: number,
  seed: number,
  onProgress: (progress: ProgressEvent) => void,
): Promise<MonteCarloResult> {
  const { solve } = await import("../solver/solve");
  const result = (solve({ ...input, monteCarloRuns: runs, monteCarloSeed: seed }, onProgress)
    .monteCarlo || null) as MonteCarloResult | null;
  if (!result) throw new Error("Monte Carlo validation failed.");
  return result;
}
