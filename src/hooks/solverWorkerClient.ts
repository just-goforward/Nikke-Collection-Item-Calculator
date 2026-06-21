import { useCallback, useEffect, useRef } from "react";

import { ignoreExpectedError } from "../lib/errorHandling";
import { solverBackendFromRuntime, solverWasmUrl } from "../lib/solverRuntime";
import { WorkerResponseSchema } from "../schemas";
import type { ProgressEvent, SolverInput, WorkerTaskType } from "../types";

const RUST_BACKEND_TIMEOUT_MS = 15_000;
const WORKER_MESSAGE_ID_KEY = "id";

type RequestWorkerOptions = {
  payload?: Record<string, unknown>;
  onProgress?: (progress: ProgressEvent) => void;
};

type WorkerRuntimeOptions = ReturnType<typeof runtimeWorkerOptions>;

type WorkerEventOutcome =
  | { kind: "ignore" }
  | { kind: "progress"; progress: ProgressEvent }
  | { kind: "reject"; error: Error }
  | { kind: "resolve"; result: unknown };

type WorkerTaskRequest = {
  activeWorker: Worker;
  id: number;
  input: SolverInput;
  options: RequestWorkerOptions;
  resetActiveWorker: (worker: Worker) => void;
  runtime: WorkerRuntimeOptions;
  type: WorkerTaskType;
};

function normalizeProgressEvent(progress: {
  phase: string;
  scanned?: number | undefined;
  total?: number | null | undefined;
}): ProgressEvent {
  return {
    phase: progress.phase,
    ...(progress.scanned !== undefined ? { scanned: progress.scanned } : {}),
    ...(progress.total !== undefined ? { total: progress.total } : {}),
  };
}

function rawWorkerMessageId(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>)[WORKER_MESSAGE_ID_KEY];
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

function runtimeWorkerOptions() {
  const backend = solverBackendFromRuntime();
  const isRustBackend = backend === "rust-phase2" || backend === "rust-min-ef";
  return {
    backend,
    isRustBackend,
    wasmUrl: isRustBackend ? solverWasmUrl() : undefined,
  };
}

const RUST_WORKER_TIMEOUT_MESSAGE = "Rust solver timed out; falling back to JS solver.";

function workerEventOutcome(data: unknown, id: number): WorkerEventOutcome {
  const parsed = WorkerResponseSchema.safeParse(data || {});
  if (!parsed.success) {
    return rawWorkerMessageId(data) === id
      ? { kind: "reject", error: new Error("Invalid worker response.") }
      : { kind: "ignore" };
  }
  const response = parsed.data;
  if (response.id !== id) return { kind: "ignore" };
  if (response.type === "progress") {
    return { kind: "progress", progress: normalizeProgressEvent(response.progress) };
  }
  if (response.type === "result") return { kind: "resolve", result: response.result };
  return { kind: "reject", error: new Error(response.message || "Worker calculation failed.") };
}

function startWorkerTask({
  activeWorker,
  id,
  input,
  options,
  resetActiveWorker,
  runtime,
  type,
}: WorkerTaskRequest) {
  return new Promise<unknown>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = null;
      activeWorker.removeEventListener("message", handleMessage);
      activeWorker.removeEventListener("error", handleError);
    };
    const handleMessage = (event: MessageEvent) => {
      const outcome = workerEventOutcome(event.data, id);
      if (outcome.kind === "ignore") return;
      if (outcome.kind === "progress") {
        options.onProgress?.(outcome.progress);
        return;
      }
      cleanup();
      if (outcome.kind === "resolve") resolve(outcome.result);
      else reject(outcome.error);
    };
    const handleError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || "Worker calculation failed."));
    };

    activeWorker.addEventListener("message", handleMessage);
    activeWorker.addEventListener("error", handleError);
    if (runtime.isRustBackend) {
      timeoutId = setTimeout(() => {
        cleanup();
        activeWorker.terminate();
        resetActiveWorker(activeWorker);
        reject(new Error(RUST_WORKER_TIMEOUT_MESSAGE));
      }, RUST_BACKEND_TIMEOUT_MS);
    }
    activeWorker.postMessage({
      type,
      id,
      input,
      backend: runtime.backend,
      wasmUrl: runtime.wasmUrl,
      ...(options.payload || {}),
    });
  });
}

export function useWorkerTaskClient() {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);

  const getWorker = useCallback(() => {
    if (typeof Worker === "undefined") return null;
    if (workerRef.current) return workerRef.current;
    try {
      workerRef.current = new Worker(new URL("../worker.ts", import.meta.url), { type: "module" });
      return workerRef.current;
    } catch (error) {
      ignoreExpectedError("web worker construction can fail when workers are unavailable", error);
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
      const runtime = runtimeWorkerOptions();

      return startWorkerTask({
        activeWorker,
        id,
        input,
        options,
        resetActiveWorker: (worker) => {
          if (workerRef.current === worker) workerRef.current = null;
        },
        runtime,
        type,
      });
    },
    [getWorker],
  );

  useEffect(() => () => resetWorker(), [resetWorker]);

  return { requestWorkerTask, resetWorker };
}
