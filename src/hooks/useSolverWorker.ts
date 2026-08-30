import { useCallback, useRef } from "react";

import type { WorkerSolverBackend } from "../../shared/workerProtocol";
import { parallelValidationFromRuntime, solverBackendFromRuntime } from "../lib/solverRuntime";
import { resolveRuntimeSupplyForecast } from "../lib/supplyForecastRuntime";
import type { ProgressEvent, SolverInput } from "../types";
import type { RuntimeInvariantReporter } from "./calculatorDiagnostics";
import {
  inputKey,
  type MonteCarloResult,
  readCache,
  rememberCache,
  type SolveOutcome,
  type SolverResult,
} from "./calculatorShared";
import { validateWithJsFallback } from "./solverFallback";
import { solveWithClientRecovery } from "./solverRecovery";
import { WORKER_ERROR_TRAITS } from "./solverRecoveryPolicy";
import {
  classifyWorkerFailure,
  useWorkerTaskClient,
  type WorkerClientTiming,
  type WorkerTaskError,
} from "./solverWorkerClient";

const SOLVE_CACHE_LIMIT = 32;
const VALIDATION_CACHE_LIMIT = 16;

function activeForecastCachePrefix() {
  const { forecastId, profile } = resolveRuntimeSupplyForecast();
  return [
    forecastId,
    profile.id,
    profile.expectedGain.blue,
    profile.expectedGain.purple,
    profile.expectedGain.yellow,
  ].join("|");
}

export function makeSolveCacheKey(
  backend: ReturnType<typeof solverBackendFromRuntime>,
  input: SolverInput,
) {
  return `${activeForecastCachePrefix()}|${backend}|${inputKey(input)}`;
}

export function readSolveCache(
  cache: Map<string, SolverResult>,
  key: string,
  requestedBackend: ReturnType<typeof solverBackendFromRuntime>,
): SolveOutcome | null {
  const result = readCache(cache, key);
  return result ? { executionKind: "cache_hit", requestedBackend, result } : null;
}

export async function resolveWorkerOrFallback<T>({
  fallback,
  workerPromise,
}: {
  fallback: () => Promise<T>;
  workerPromise: Promise<unknown> | null;
}): Promise<{ result: T; workerError: WorkerTaskError | null }> {
  if (workerPromise) {
    try {
      return { result: (await workerPromise) as T, workerError: null };
    } catch (error) {
      const failure = classifyWorkerFailure(error);
      if (failure.kind !== "worker_error") throw failure.error;
      const workerError = failure.error;
      const traits = WORKER_ERROR_TRAITS[workerError.code];
      if (!workerError.fallbackEligible || !traits.jsSemanticallySafe) throw workerError;
      return { result: await fallback(), workerError };
    }
  }
  return { result: await fallback(), workerError: null };
}

function withWorkerTimingStats(
  result: SolverResult,
  timing: WorkerClientTiming | null,
): SolverResult {
  if (!timing) return result;
  return {
    ...result,
    stats: {
      ...(result.stats || {}),
      workerEndToEndMs: timing.endToEndMs,
      workerExecutionMs: timing.executionMs,
      workerLane: timing.lane,
      workerQueueWaitMs: timing.queueWaitMs,
    },
  };
}

export function useSolverWorker(
  onSolveProgress: (progress: ProgressEvent) => void,
  reportRuntimeInvariant?: RuntimeInvariantReporter,
) {
  const solveCacheRef = useRef(new Map<string, SolverResult>());
  const validationCacheRef = useRef(new Map<string, MonteCarloResult>());
  const {
    preemptValidationForSolve: preemptSharedValidation,
    requestWorkerTask: requestSharedTask,
    resetFailedWorker: resetSharedWorker,
  } = useWorkerTaskClient({
    lane: "shared",
    ...(reportRuntimeInvariant ? { onInvariant: reportRuntimeInvariant } : {}),
  });
  const {
    preemptValidationForSolve: preemptDedicatedValidation,
    requestWorkerTask: requestValidationTask,
  } = useWorkerTaskClient({
    idleTimeoutMs: 30_000,
    lane: "validation",
    ...(reportRuntimeInvariant ? { onInvariant: reportRuntimeInvariant } : {}),
  });
  const parallelValidation = parallelValidationFromRuntime();

  const cancelValidationForSolve = useCallback(() => {
    const sharedError = preemptSharedValidation();
    if (sharedError) return sharedError;
    return preemptDedicatedValidation();
  }, [preemptDedicatedValidation, preemptSharedValidation]);

  const solveBestAvailable = useCallback(
    async (input: SolverInput) => {
      const backend = solverBackendFromRuntime();
      const key = makeSolveCacheKey(backend, input);
      const cached = readSolveCache(solveCacheRef.current, key, backend);
      if (cached) return cached;
      const recovered = await solveWithClientRecovery({
        input,
        onProgress: onSolveProgress,
        preemptValidationForNextRung: cancelValidationForSolve,
        primaryBackend: backend,
        requestWorkerTask: requestSharedTask,
        resetFailedWorker: resetSharedWorker,
      });
      const solved = rememberCache(
        solveCacheRef.current,
        key,
        withWorkerTimingStats(recovered.result, recovered.timing),
        SOLVE_CACHE_LIMIT,
      );
      return {
        executionKind: "executed",
        recoveryTrace: recovered.trace,
        requestedBackend: backend,
        result: solved,
      } satisfies SolveOutcome;
    },
    [cancelValidationForSolve, onSolveProgress, requestSharedTask, resetSharedWorker],
  );

  const validateBestAvailable = useCallback(
    async (
      input: SolverInput,
      runs: number,
      onProgress: (progress: ProgressEvent) => void,
      options: { backend?: WorkerSolverBackend; force?: boolean; seed?: number } = {},
    ) => {
      const seed = Math.max(0, Math.floor(Number(options.seed) || 20260505));
      const backend = options.backend ?? solverBackendFromRuntime();
      const key = `${activeForecastCachePrefix()}|${backend}|${inputKey(input)}|mc:${runs}|seed:${seed}`;
      const cached = readCache(validationCacheRef.current, key);
      if (!options.force && cached) return cached;
      const requestTask = parallelValidation ? requestValidationTask : requestSharedTask;
      let timing: WorkerClientTiming | null = null;
      const { result } = await resolveWorkerOrFallback<MonteCarloResult>({
        fallback: () => validateWithJsFallback(input, runs, seed, onProgress),
        workerPromise: requestTask("validate", input, {
          backend,
          payload: { runs, seed },
          onProgress,
          onTiming: (value) => {
            timing = value;
          },
        }),
      });
      return rememberCache(
        validationCacheRef.current,
        key,
        timing ? { ...result, workerTiming: timing } : result,
        VALIDATION_CACHE_LIMIT,
      );
    },
    [parallelValidation, requestSharedTask, requestValidationTask],
  );

  return { cancelValidationForSolve, solveBestAvailable, validateBestAvailable };
}
