import { useCallback, useEffect, useRef } from "react";

import type { SolverInput } from "../../shared/game";
import {
  type ProgressEvent,
  parseWorkerResponse,
  type WorkerErrorCode,
  type WorkerErrorPayload,
  type WorkerSolverBackend,
  type WorkerTaskTiming,
  type WorkerTaskType,
} from "../../shared/workerProtocol";
import { ignoreExpectedError } from "../lib/errorHandling";
import { solverBackendFromRuntime, solverWasmUrl } from "../lib/solverRuntime";

const RUST_EXECUTION_TIMEOUT_MS = 15_000;
const RUST_QUEUE_TIMEOUT_MS = 30_000;

type WorkerClientLane = "shared" | "validation";
export type WorkerClientTiming = WorkerTaskTiming & {
  endToEndMs: number;
  lane: WorkerClientLane;
};

type RequestWorkerOptions = {
  backend?: WorkerSolverBackend;
  executionTimeoutMs?: number;
  payload?: Record<string, unknown>;
  onProgress?: (progress: ProgressEvent) => void;
  onTiming?: (timing: WorkerClientTiming) => void;
  queueTimeoutMs?: number;
};

export type WorkerTaskRequester = (
  type: WorkerTaskType,
  input: SolverInput,
  options?: RequestWorkerOptions,
) => Promise<unknown>;

type WorkerTaskClientOptions = {
  idleTimeoutMs?: number;
  lane?: WorkerClientLane;
};

type WorkerRuntimeOptions = ReturnType<typeof runtimeWorkerOptions>;
type WorkerMessageListener = (event: MessageEvent) => void;
type WorkerErrorListener = (event: ErrorEvent) => void;

type WorkerPort = {
  addEventListener(type: "message", listener: WorkerMessageListener): void;
  addEventListener(type: "error", listener: WorkerErrorListener): void;
  postMessage(message: unknown): void;
  removeEventListener(type: "message", listener: WorkerMessageListener): void;
  removeEventListener(type: "error", listener: WorkerErrorListener): void;
  terminate(): void;
};

export type WorkerTaskCancellation =
  | { reason: "component_unmount"; task: "solve" }
  | { reason: "component_unmount" | "validation_preempted"; task: "validate" };

export class WorkerTaskCancelled extends Error {
  readonly cancellation: WorkerTaskCancellation;
  readonly kind = "cancelled" as const;

  constructor(cancellation: WorkerTaskCancellation) {
    super(cancellationMessage(cancellation));
    this.name = "WorkerTaskCancelled";
    this.cancellation = cancellation;
  }
}

export class WorkerTaskError extends Error {
  readonly code: WorkerErrorCode;
  readonly fallbackEligible: boolean;
  readonly kind = "worker_error" as const;
  readonly nodeCount: number | null;
  readonly retryable: boolean;

  constructor(payload: WorkerErrorPayload) {
    super(payload.message);
    this.name = "WorkerTaskError";
    this.code = payload.code;
    this.fallbackEligible = payload.fallbackEligible ?? true;
    this.nodeCount = payload.nodeCount ?? null;
    this.retryable = payload.retryable ?? true;
  }
}

export type WorkerTaskFailure = WorkerTaskCancelled | WorkerTaskError;
export type ClassifiedWorkerFailure =
  | { error: WorkerTaskCancelled; kind: "cancelled" }
  | { error: WorkerTaskError; kind: "worker_error" }
  | { error: Error; kind: "unexpected" };

type WorkerEventOutcome =
  | { kind: "ignore" }
  | { kind: "invalid"; error: WorkerTaskError }
  | { kind: "progress"; progress: ProgressEvent }
  | { kind: "reject"; error: WorkerTaskError }
  | { kind: "resolve"; result: unknown; timing?: WorkerTaskTiming };

type WorkerTaskRequest = {
  activeWorker: WorkerPort;
  failActiveWorker: (worker: WorkerPort, payload: WorkerErrorPayload) => void;
  id: number;
  input: SolverInput;
  lane: WorkerClientLane;
  options: RequestWorkerOptions;
  registerPending: (finishWithFailure: (failure: WorkerTaskFailure) => void) => void;
  runtime: WorkerRuntimeOptions;
  type: WorkerTaskType;
  unregisterPending: () => void;
};

type PendingTask = {
  finishWithFailure: (failure: WorkerTaskFailure) => void;
  type: WorkerTaskType;
};

type TaskCompletion =
  | { kind: "resolve"; result: unknown }
  | { failure: WorkerTaskFailure; kind: "reject" };

function runtimeWorkerOptions(backendOverride?: WorkerSolverBackend) {
  const backend = backendOverride ?? solverBackendFromRuntime();
  const isRustBackend = backend === "rust-phase2" || backend === "rust-min-ef";
  return {
    backend,
    isRustBackend,
    wasmUrl: isRustBackend ? solverWasmUrl() : undefined,
  };
}

const RUST_WORKER_TIMEOUT_MESSAGE = "Rust solver execution timed out; falling back to JS solver.";
const JS_WORKER_TIMEOUT_MESSAGE = "JS solver execution timed out.";

function workerTaskError(payload: WorkerErrorPayload) {
  return new WorkerTaskError(payload);
}

function cancellationMessage(cancellation: WorkerTaskCancellation) {
  if (cancellation.reason === "validation_preempted") {
    return "Validation was cancelled for a newer solve.";
  }
  return `${cancellation.task} task was cancelled because its component unmounted.`;
}

function positiveTimeout(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value) || Number(value) <= 0) return fallback;
  return Math.max(1, Math.floor(Number(value)));
}

export function classifyWorkerFailure(error: unknown): ClassifiedWorkerFailure {
  if (error instanceof WorkerTaskCancelled) return { error, kind: "cancelled" };
  if (error instanceof WorkerTaskError) return { error, kind: "worker_error" };
  if (error instanceof Error) return { error, kind: "unexpected" };
  return {
    error: new Error("Unexpected worker failure.", { cause: error }),
    kind: "unexpected",
  };
}

export function workerEventOutcome(data: unknown, id: number): WorkerEventOutcome {
  const parsed = parseWorkerResponse(data);
  if (!parsed.success) return invalidWorkerResponse();
  const message = parsed.data;
  if (message.id !== id) return { kind: "ignore" };
  if (message.type === "progress") return { kind: "progress", progress: message.progress };
  if (message.type === "result") {
    return {
      kind: "resolve",
      result: message.result,
      ...(message.timing ? { timing: message.timing } : {}),
    };
  }
  return { kind: "reject", error: workerTaskError(message) };
}

export function createTaskFinisher({
  cleanup,
  reject,
  resolve,
}: {
  cleanup: () => void;
  reject: (failure: WorkerTaskFailure) => void;
  resolve: (result: unknown) => void;
}) {
  let settled = false;
  return (completion: TaskCompletion) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (completion.kind === "resolve") resolve(completion.result);
    else reject(completion.failure);
  };
}

export function solvePreemptionError(pendingTypes: readonly WorkerTaskType[]) {
  if (pendingTypes.some((type) => type !== "validate")) {
    return workerTaskError({
      code: "solve_in_flight",
      fallbackEligible: false,
      message: "A solve task is already in flight.",
      retryable: false,
    });
  }
  return null;
}

function invalidWorkerResponse(): WorkerEventOutcome {
  return {
    kind: "invalid",
    error: workerTaskError({
      code: "invalid_worker_response",
      fallbackEligible: false,
      message: "Invalid worker response.",
      retryable: false,
    }),
  };
}

function startWorkerTask({
  activeWorker,
  failActiveWorker,
  id,
  input,
  lane,
  options,
  registerPending,
  runtime,
  type,
  unregisterPending,
}: WorkerTaskRequest) {
  return new Promise<unknown>((rawResolve, rawReject) => {
    const requestedAt = performance.now();
    const executionTimeoutMs = positiveTimeout(
      options.executionTimeoutMs,
      RUST_EXECUTION_TIMEOUT_MS,
    );
    const queueTimeoutMs = positiveTimeout(options.queueTimeoutMs, RUST_QUEUE_TIMEOUT_MS);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = null;
      activeWorker.removeEventListener("message", handleMessage);
      activeWorker.removeEventListener("error", handleError);
      unregisterPending();
    };
    const finish = createTaskFinisher({ cleanup, reject: rawReject, resolve: rawResolve });
    const failForTimeout = (payload: WorkerErrorPayload) => {
      failActiveWorker(activeWorker, payload);
    };
    const armExecutionTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        failForTimeout({
          code: runtime.isRustBackend ? "rust_timeout" : "worker_timeout",
          fallbackEligible: true,
          message: runtime.isRustBackend ? RUST_WORKER_TIMEOUT_MESSAGE : JS_WORKER_TIMEOUT_MESSAGE,
          retryable: true,
        });
      }, executionTimeoutMs);
    };
    const handleMessage = (event: MessageEvent) => {
      const outcome = workerEventOutcome(event.data, id);
      if (outcome.kind === "ignore") return;
      if (outcome.kind === "invalid") {
        failActiveWorker(activeWorker, {
          code: outcome.error.code,
          fallbackEligible: outcome.error.fallbackEligible,
          message: outcome.error.message,
          ...(outcome.error.nodeCount === null ? {} : { nodeCount: outcome.error.nodeCount }),
          retryable: outcome.error.retryable,
        });
        return;
      }
      if (outcome.kind === "progress") {
        if (outcome.progress.phase === "worker-started") armExecutionTimeout();
        options.onProgress?.(outcome.progress);
        return;
      }
      if (outcome.kind === "resolve") {
        const timing = outcome.timing ?? { queueWaitMs: 0, executionMs: 0 };
        finish({ kind: "resolve", result: outcome.result });
        options.onTiming?.({
          ...timing,
          endToEndMs: performance.now() - requestedAt,
          lane,
        });
        return;
      }
      finish({ failure: outcome.error, kind: "reject" });
    };
    const handleError = (event: ErrorEvent) => {
      failActiveWorker(activeWorker, {
        code: "worker_error",
        fallbackEligible: true,
        message: event.message || "Worker calculation failed.",
        retryable: true,
      });
    };

    activeWorker.addEventListener("message", handleMessage);
    activeWorker.addEventListener("error", handleError);
    registerPending((failure) => finish({ failure, kind: "reject" }));
    if (runtime.isRustBackend) {
      timeoutId = setTimeout(() => {
        failForTimeout({
          code: "worker_queue_timeout",
          fallbackEligible: true,
          message: "Rust solver queue timed out; falling back to JS solver.",
          retryable: true,
        });
      }, queueTimeoutMs);
    }
    try {
      activeWorker.postMessage({
        type,
        id,
        input,
        backend: runtime.backend,
        wasmUrl: runtime.wasmUrl,
        ...(options.payload || {}),
      });
      if (!runtime.isRustBackend) armExecutionTimeout();
    } catch (error) {
      failActiveWorker(activeWorker, {
        code: "worker_error",
        fallbackEligible: true,
        message: error instanceof Error ? error.message : "Worker request failed.",
        retryable: true,
      });
    }
  });
}

function useRequestWorkerTask({
  failWorker,
  getWorker,
  lane,
  pendingRef,
  preemptValidationForSolve,
  requestIdRef,
  scheduleIdleRelease,
}: {
  failWorker: (payload: WorkerErrorPayload, expectedWorker?: WorkerPort) => void;
  getWorker: () => WorkerPort | null;
  lane: WorkerClientLane;
  pendingRef: { current: Map<number, PendingTask> };
  preemptValidationForSolve: () => WorkerTaskError | null;
  requestIdRef: { current: number };
  scheduleIdleRelease: () => void;
}) {
  return useCallback(
    (type: WorkerTaskType, input: SolverInput, requestOptions: RequestWorkerOptions = {}) => {
      if (type === "solve") {
        const preemptionError = preemptValidationForSolve();
        if (preemptionError) return Promise.reject(preemptionError);
      }
      const activeWorker = getWorker();
      if (!activeWorker) {
        return Promise.reject(
          workerTaskError({
            code: "worker_unavailable",
            fallbackEligible: true,
            message: "Web worker is unavailable.",
            retryable: false,
          }),
        );
      }
      requestIdRef.current += 1;
      const id = requestIdRef.current;
      return startWorkerTask({
        activeWorker,
        failActiveWorker: (worker, payload) => failWorker(payload, worker),
        id,
        input,
        lane,
        options: requestOptions,
        registerPending: (finishWithFailure) => {
          pendingRef.current.set(id, { finishWithFailure, type });
        },
        runtime: runtimeWorkerOptions(requestOptions.backend),
        type,
        unregisterPending: () => {
          pendingRef.current.delete(id);
          scheduleIdleRelease();
        },
      });
    },
    [
      failWorker,
      getWorker,
      lane,
      pendingRef,
      preemptValidationForSolve,
      requestIdRef,
      scheduleIdleRelease,
    ],
  );
}

export function useWorkerTaskClient(options: WorkerTaskClientOptions = {}) {
  const workerRef = useRef<WorkerPort | null>(null);
  const requestIdRef = useRef(0);
  const pendingRef = useRef(new Map<number, PendingTask>());
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lane = options.lane ?? "shared";
  const idleTimeoutMs = Math.max(0, options.idleTimeoutMs ?? 0);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
  }, []);

  const failWorker = useCallback(
    (payload: WorkerErrorPayload, expectedWorker?: WorkerPort) => {
      if (expectedWorker && workerRef.current !== expectedWorker) return;
      clearIdleTimer();
      workerRef.current?.terminate();
      workerRef.current = null;
      const failure = workerTaskError(payload);
      const pending = [...pendingRef.current.values()];
      pendingRef.current.clear();
      for (const task of pending) task.finishWithFailure(failure);
    },
    [clearIdleTimer],
  );

  const disposeAllTasksForUnmount = useCallback(() => {
    clearIdleTimer();
    workerRef.current?.terminate();
    workerRef.current = null;
    const pending = [...pendingRef.current.values()];
    pendingRef.current.clear();
    for (const task of pending) {
      task.finishWithFailure(
        new WorkerTaskCancelled({ reason: "component_unmount", task: task.type }),
      );
    }
  }, [clearIdleTimer]);

  const releaseIdleWorker = useCallback(() => {
    if (pendingRef.current.size > 0) {
      console.error("Worker idle-release invariant failed: pending tasks are still active.");
      return;
    }
    clearIdleTimer();
    workerRef.current?.terminate();
    workerRef.current = null;
  }, [clearIdleTimer]);

  const resetFailedWorker = useCallback(() => {
    if (pendingRef.current.size > 0) {
      return workerTaskError({
        code: "solve_in_flight",
        fallbackEligible: false,
        message: "A failed Worker cannot be reset while tasks are pending.",
        retryable: false,
      });
    }
    clearIdleTimer();
    workerRef.current?.terminate();
    workerRef.current = null;
    return null;
  }, [clearIdleTimer]);

  const scheduleIdleRelease = useCallback(() => {
    if (idleTimeoutMs <= 0 || pendingRef.current.size > 0 || !workerRef.current) return;
    clearIdleTimer();
    idleTimerRef.current = setTimeout(releaseIdleWorker, idleTimeoutMs);
  }, [clearIdleTimer, idleTimeoutMs, releaseIdleWorker]);

  const preemptValidationForSolve = useCallback(() => {
    const pending = [...pendingRef.current.values()];
    if (pending.length === 0) return null;
    const preemptionError = solvePreemptionError(pending.map((task) => task.type));
    if (preemptionError) return preemptionError;
    clearIdleTimer();
    workerRef.current?.terminate();
    workerRef.current = null;
    pendingRef.current.clear();
    for (const task of pending) {
      task.finishWithFailure(
        new WorkerTaskCancelled({ reason: "validation_preempted", task: "validate" }),
      );
    }
    return null;
  }, [clearIdleTimer]);

  const getWorker = useCallback(() => {
    clearIdleTimer();
    if (typeof Worker === "undefined") return null;
    if (workerRef.current) return workerRef.current;
    try {
      workerRef.current = new Worker(new URL("../worker.ts", import.meta.url), { type: "module" });
      return workerRef.current;
    } catch (error) {
      ignoreExpectedError("web worker construction can fail when workers are unavailable", error);
      return null;
    }
  }, [clearIdleTimer]);

  const requestWorkerTask = useRequestWorkerTask({
    failWorker,
    getWorker,
    lane,
    pendingRef,
    preemptValidationForSolve,
    requestIdRef,
    scheduleIdleRelease,
  });

  useEffect(() => disposeAllTasksForUnmount, [disposeAllTasksForUnmount]);

  return {
    disposeAllTasksForUnmount,
    preemptValidationForSolve,
    requestWorkerTask,
    resetFailedWorker,
  };
}
