import { useCallback, useRef } from "react";

import { solverBackendFromRuntime } from "../lib/solverRuntime";
import type { ProgressEvent, SolverInput } from "../types";
import {
  inputKey,
  type MonteCarloResult,
  rememberCache,
  type SolverResult,
} from "./calculatorShared";
import { solveWithJsFallback, validateWithJsFallback } from "./solverFallback";
import { useWorkerTaskClient } from "./solverWorkerClient";

const SOLVE_CACHE_LIMIT = 32;
const VALIDATION_CACHE_LIMIT = 16;

async function resolveWorkerOrFallback<T>({
  fallback,
  onWorkerError,
  workerPromise,
}: {
  fallback: () => Promise<T>;
  onWorkerError: () => void;
  workerPromise: Promise<unknown> | null;
}) {
  if (workerPromise) {
    try {
      return (await workerPromise) as T;
    } catch {
      onWorkerError();
    }
  }
  return fallback();
}

export function useSolverWorker(onSolveProgress: (progress: ProgressEvent) => void) {
  const solveCacheRef = useRef(new Map<string, SolverResult>());
  const validationCacheRef = useRef(new Map<string, MonteCarloResult>());
  const { requestWorkerTask, resetWorker } = useWorkerTaskClient();

  const solveBestAvailable = useCallback(
    async (input: SolverInput) => {
      const backend = solverBackendFromRuntime();
      const key = `${backend}|${inputKey(input)}`;
      const cached = solveCacheRef.current.get(key);
      if (cached) return cached;
      const result = await resolveWorkerOrFallback<SolverResult>({
        fallback: () => solveWithJsFallback(input, onSolveProgress),
        onWorkerError: resetWorker,
        workerPromise: requestWorkerTask("solve", input, { onProgress: onSolveProgress }),
      });
      return rememberCache(solveCacheRef.current, key, result, SOLVE_CACHE_LIMIT);
    },
    [onSolveProgress, requestWorkerTask, resetWorker],
  );

  const validateBestAvailable = useCallback(
    async (
      input: SolverInput,
      runs: number,
      onProgress: (progress: ProgressEvent) => void,
      options: { force?: boolean; seed?: number } = {},
    ) => {
      const seed = Math.max(0, Math.floor(Number(options.seed) || 20260505));
      const backend = solverBackendFromRuntime();
      const key = `${backend}|${inputKey(input)}|mc:${runs}|seed:${seed}`;
      const cached = validationCacheRef.current.get(key);
      if (!options.force && cached) return cached;
      const result = await resolveWorkerOrFallback<MonteCarloResult>({
        fallback: () => validateWithJsFallback(input, runs, seed, onProgress),
        onWorkerError: resetWorker,
        workerPromise: requestWorkerTask("validate", input, {
          payload: { runs, seed },
          onProgress,
        }),
      });
      return rememberCache(validationCacheRef.current, key, result, VALIDATION_CACHE_LIMIT);
    },
    [requestWorkerTask, resetWorker],
  );

  return { solveBestAvailable, validateBestAvailable };
}
