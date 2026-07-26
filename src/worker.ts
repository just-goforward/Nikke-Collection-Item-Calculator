import {
  type ProgressEvent,
  parseWorkerRequest,
  type WorkerErrorCode,
  type WorkerErrorPayload,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerTaskTiming,
  workerMessageId,
} from "../shared/workerProtocol";
import { solve } from "./solver/solve";
import { solveRustMinEf } from "./wasm/rustMinEfSolver";
import { solveRustPhase2 } from "./wasm/rustPhase2ProductSolver";
import { validateRustMinEf, validateRustPhase2 } from "./wasm/rustProductValidation";
import {
  RUST_STATUS_BUDGET_EXCEEDED,
  RUST_STATUS_MEMO_FULL,
  RustSolveError,
} from "./wasm/rustStatus";

function postWorkerMessage(message: WorkerResponse) {
  self.postMessage(message);
}

let rustTaskQueue: Promise<void> = Promise.resolve();

function runRustTask<T>(
  task: () => Promise<T>,
  onStart: (queueWaitMs: number) => void,
): Promise<{ result: T; timing: WorkerTaskTiming }> {
  const queuedAt = performance.now();
  const execute = async () => {
    const startedAt = performance.now();
    const queueWaitMs = startedAt - queuedAt;
    onStart(queueWaitMs);
    const result = await task();
    return {
      result,
      timing: { queueWaitMs, executionMs: performance.now() - startedAt },
    };
  };
  const run = rustTaskQueue.then(execute, execute);
  rustTaskQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function postWorkerProgress(id: number, progress: ProgressEvent) {
  postWorkerMessage({ type: "progress", id, progress });
}

function requireWasmUrl(data: WorkerRequest) {
  const wasmUrl = typeof data.wasmUrl === "string" ? data.wasmUrl : "";
  if (wasmUrl) return wasmUrl;
  throw workerTaskError({
    code: "wasm_url_missing",
    fallbackEligible: true,
    message: "Rust solver WASM URL is missing.",
    retryable: false,
  });
}

async function handleRustValidation(data: Extract<WorkerRequest, { type: "validate" }>) {
  const wasmUrl = requireWasmUrl(data);
  const runs = Math.max(0, Math.floor(Number(data.runs) || 0));
  const seed = Math.max(0, Math.floor(Number(data.seed) || 20260505));
  const validateRust = data.backend === "rust-phase2" ? validateRustPhase2 : validateRustMinEf;
  const { result, timing } = await runRustTask(
    () => validateRust(data.input, wasmUrl, runs, seed),
    (queueWaitMs) => postWorkerProgress(data.id, { phase: "worker-started", queueWaitMs }),
  );
  postWorkerMessage({ type: "result", id: data.id, result, timing });
}

async function handleRustSolve(data: Extract<WorkerRequest, { type: "solve" }>) {
  const wasmUrl = requireWasmUrl(data);
  const reportProgress = (progress: ProgressEvent) => postWorkerProgress(data.id, progress);
  const { result, timing } = await runRustTask(
    () =>
      data.backend === "rust-phase2"
        ? solveRustPhase2(data.input, wasmUrl, reportProgress, {
            ...(data.phase2MemoTier === undefined ? {} : { initialMemoTier: data.phase2MemoTier }),
            ...(data.phase2RetryOnMemoFull === undefined
              ? {}
              : { retryOnMemoFull: data.phase2RetryOnMemoFull }),
          })
        : solveRustMinEf(data.input, wasmUrl, reportProgress),
    (queueWaitMs) => postWorkerProgress(data.id, { phase: "worker-started", queueWaitMs }),
  );
  postWorkerMessage({ type: "result", id: data.id, result, timing });
}

async function handleRustRequest(data: WorkerRequest) {
  if (data.type === "validate") return handleRustValidation(data);
  return handleRustSolve(data);
}

function handleJsRequest(data: WorkerRequest) {
  const input =
    data.type === "validate"
      ? {
          ...data.input,
          monteCarloRuns: Math.max(0, Math.floor(Number(data.runs) || 0)),
          monteCarloSeed: Math.max(0, Math.floor(Number(data.seed) || 20260505)),
        }
      : data.input;
  const startedAt = performance.now();
  const result = solve(input, (progress: ProgressEvent) => postWorkerProgress(data.id, progress));
  postWorkerMessage({
    type: "result",
    id: data.id,
    result: data.type === "validate" ? result.monteCarlo : result,
    timing: { queueWaitMs: 0, executionMs: performance.now() - startedAt },
  });
}

async function dispatchWorkerRequest(data: WorkerRequest) {
  if (data.backend === "rust-phase2" || data.backend === "rust-min-ef") {
    await handleRustRequest(data);
    return;
  }
  handleJsRequest(data);
}

self.onmessage = async (event) => {
  const parsed = parseWorkerRequest(event.data);
  if (!parsed.success) {
    postWorkerMessage({
      type: "error",
      id: workerMessageId(event.data),
      code: "invalid_worker_payload",
      fallbackEligible: false,
      message: "Invalid worker request.",
      retryable: false,
    });
    return;
  }
  try {
    await dispatchWorkerRequest(parsed.data);
  } catch (error) {
    postWorkerMessage({ type: "error", id: parsed.data.id, ...workerErrorPayload(error) });
  }
};

function workerTaskError(payload: WorkerErrorPayload) {
  const error = new Error(payload.message) as Error & { workerPayload?: WorkerErrorPayload };
  error.workerPayload = payload;
  return error;
}

function workerErrorPayload(error: unknown): WorkerErrorPayload {
  const workerPayload =
    error instanceof Error
      ? (error as Error & { workerPayload?: WorkerErrorPayload }).workerPayload
      : undefined;
  if (workerPayload) return workerPayload;

  if (error instanceof RustSolveError) {
    const code = rustSolveErrorCode(error);
    return {
      code,
      fallbackEligible: code !== "stale_handle" && code !== "unknown_rust_status",
      message: error.message,
      ...(error.nodeCount === null ? {} : { nodeCount: error.nodeCount }),
      retryable: error.reason === "status",
    };
  }

  if (typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError) {
    return {
      code: "wasm_trap",
      fallbackEligible: false,
      message: "Rust solver execution trapped.",
      retryable: false,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    code: inferWorkerErrorCode(message),
    fallbackEligible: true,
    message,
    retryable: true,
  };
}

function rustSolveErrorCode(error: RustSolveError): WorkerErrorCode {
  if (error.reason === "missing_export") return "missing_export";
  if (error.reason === "stale_handle") return "stale_handle";
  if (error.reason === "status" && error.status === RUST_STATUS_MEMO_FULL) return "memo_full";
  if (error.reason === "status" && error.status === RUST_STATUS_BUDGET_EXCEEDED) {
    return "budget_exceeded";
  }
  if (error.reason === "status") return "unknown_rust_status";
  return "worker_error";
}

function inferWorkerErrorCode(message: string): WorkerErrorCode {
  if (/wasm|webassembly|instantiate|fetch/i.test(message)) return "wasm_load_failed";
  return "worker_error";
}
