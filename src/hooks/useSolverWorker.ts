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
import { useWorkerTaskClient, WorkerTaskError } from "./solverWorkerClient";

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
}): Promise<{ result: T; workerError: WorkerTaskError | null }> {
  if (workerPromise) {
    try {
      return { result: (await workerPromise) as T, workerError: null };
    } catch (error) {
      onWorkerError();
      const workerError =
        error instanceof WorkerTaskError
          ? error
          : new WorkerTaskError({
              code: "worker_error",
              fallbackEligible: true,
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
            });
      return { result: await fallback(), workerError };
    }
  }
  return { result: await fallback(), workerError: null };
}

function withWorkerFallbackStats(
  result: SolverResult,
  attemptedBackend: string,
  workerError: WorkerTaskError | null,
): SolverResult {
  if (!workerError) return result;
  return {
    ...result,
    stats: {
      ...(result.stats || {}),
      fallbackFrom: attemptedBackend,
      fallbackReason: workerError.code,
      solverBackend: result.stats?.solverBackend || "js-phase2",
      workerErrorCode: workerError.code,
    },
  };
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
      const { result, workerError } = await resolveWorkerOrFallback<SolverResult>({
        fallback: () => solveWithJsFallback(input, onSolveProgress),
        onWorkerError: resetWorker,
        workerPromise: requestWorkerTask("solve", input, { onProgress: onSolveProgress }),
      });
      return rememberCache(
        solveCacheRef.current,
        key,
        withWorkerFallbackStats(result, backend, workerError),
        SOLVE_CACHE_LIMIT,
      );
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
      const { result } = await resolveWorkerOrFallback<MonteCarloResult>({
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
