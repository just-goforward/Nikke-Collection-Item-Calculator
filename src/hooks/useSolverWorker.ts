import { useCallback, useEffect, useRef } from "react";

import {
  solverBackendFromRuntime,
  solverBackendShouldFailLoud,
  solverWasmUrl,
} from "../lib/solverRuntime";
import { WorkerResponseSchema } from "../schemas";
import type { ProgressEvent, SolverInput, WorkerTaskType } from "../types";
import {
  inputKey,
  type MonteCarloResult,
  rememberCache,
  type SolverResult,
} from "./calculatorShared";

const SOLVE_CACHE_LIMIT = 32;
const VALIDATION_CACHE_LIMIT = 16;
const RUST_BACKEND_TIMEOUT_MS = 15_000;

type RequestWorkerOptions = {
  payload?: Record<string, unknown>;
  onProgress?: (progress: ProgressEvent) => void;
};

export function useSolverWorker(onSolveProgress: (progress: ProgressEvent) => void) {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const solveCacheRef = useRef(new Map<string, SolverResult>());
  const validationCacheRef = useRef(new Map<string, MonteCarloResult>());

  const getWorker = useCallback(() => {
    if (typeof Worker === "undefined") return null;
    if (workerRef.current) return workerRef.current;
    try {
      workerRef.current = new Worker(new URL("../worker.ts", import.meta.url), { type: "module" });
      return workerRef.current;
    } catch {
      return null;
    }
  }, []);

  const resetWorker = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  const requestWorkerTask = useCallback(
    (type: WorkerTaskType, input: SolverInput, options: RequestWorkerOptions = {}) => {
      const activeWorker = getWorker();
      if (!activeWorker) return null;
      requestIdRef.current += 1;
      const id = requestIdRef.current;
      const backend = solverBackendFromRuntime();
      const failLoud = solverBackendShouldFailLoud();
      const isRustBackend = backend === "rust-phase2" || backend === "rust-phase2-rerank";
      const wasmUrl = isRustBackend ? solverWasmUrl() : undefined;

      return new Promise<unknown>((resolve, reject) => {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          activeWorker.removeEventListener("message", handleMessage);
          activeWorker.removeEventListener("error", handleError);
        };
        const handleMessage = (event: MessageEvent) => {
          const parsed = WorkerResponseSchema.safeParse(event.data || {});
          if (!parsed.success) {
            const raw = event.data || {};
            if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).id !== id)
              return;
            cleanup();
            reject(new Error("Invalid worker response."));
            return;
          }
          const data = parsed.data;
          if (data.id !== id) return;
          if (data.type === "progress") {
            options.onProgress?.(data.progress);
            return;
          }
          cleanup();
          if (data.type === "result") resolve(data.result);
          else reject(new Error(data.message || "Worker calculation failed."));
        };
        const handleError = (event: ErrorEvent) => {
          cleanup();
          reject(new Error(event.message || "Worker calculation failed."));
        };

        activeWorker.addEventListener("message", handleMessage);
        activeWorker.addEventListener("error", handleError);
        if (isRustBackend) {
          timeoutId = setTimeout(() => {
            cleanup();
            activeWorker.terminate();
            if (workerRef.current === activeWorker) workerRef.current = null;
            reject(
              new Error(
                failLoud
                  ? "Rust staging solver timed out."
                  : "Rust solver timed out; falling back to JS solver.",
              ),
            );
          }, RUST_BACKEND_TIMEOUT_MS);
        }
        activeWorker.postMessage({ type, id, input, backend, wasmUrl, ...(options.payload || {}) });
      });
    },
    [getWorker],
  );

  const solveBestAvailable = useCallback(
    async (input: SolverInput) => {
      const backend = solverBackendFromRuntime();
      const failLoud = solverBackendShouldFailLoud();
      const key = `${backend}|${inputKey(input)}`;
      const cached = solveCacheRef.current.get(key);
      if (cached) return cached;
      const workerPromise = requestWorkerTask("solve", input, { onProgress: onSolveProgress });
      if (workerPromise) {
        try {
          return rememberCache(
            solveCacheRef.current,
            key,
            (await workerPromise) as SolverResult,
            SOLVE_CACHE_LIMIT,
          );
        } catch (error) {
          resetWorker();
          if (failLoud) throw error;
        }
      }
      const { solve } = await import("../solver");
      return rememberCache(
        solveCacheRef.current,
        key,
        solve(input, onSolveProgress) as SolverResult,
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
      const failLoud = solverBackendShouldFailLoud();
      const key = `${backend}|${inputKey(input)}|mc:${runs}|seed:${seed}`;
      const cached = validationCacheRef.current.get(key);
      if (!options.force && cached) return cached;
      const workerPromise = requestWorkerTask("validate", input, {
        payload: { runs, seed },
        onProgress,
      });
      if (workerPromise) {
        try {
          return rememberCache(
            validationCacheRef.current,
            key,
            (await workerPromise) as MonteCarloResult,
            VALIDATION_CACHE_LIMIT,
          );
        } catch (error) {
          resetWorker();
          if (failLoud) throw error;
        }
      }
      const { solve } = await import("../solver");
      const result = (solve({ ...input, monteCarloRuns: runs, monteCarloSeed: seed }, onProgress)
        .monteCarlo || null) as MonteCarloResult | null;
      if (!result) throw new Error("Monte Carlo validation failed.");
      return rememberCache(validationCacheRef.current, key, result, VALIDATION_CACHE_LIMIT);
    },
    [requestWorkerTask, resetWorker],
  );

  useEffect(
    () => () => {
      workerRef.current?.terminate();
    },
    [],
  );

  return { solveBestAvailable, validateBestAvailable };
}
